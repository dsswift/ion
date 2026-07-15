// @file-size-exception: useTabRestoration-engine.ts owns buildPopulatedInstance,
// hasPlanBeenImplemented, and the full engine-tab restore flow. Splitting would
// require passing the legacy-marker filter across file boundaries; the file is
// modestly over cap and will be refactored when the restore hook is next revised.
import type { Message, AgentStateUpdate, ConversationInstance, ConversationRef } from '../../shared/types'
import type { PersistedTab, PersistedConversationInstance } from '../../shared/types-persistence'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { isExtensionErrorMessage } from '../stores/session-store-persistence'
import { pendingCardOutcome } from '../../shared/pending-card'
import { MAIN_INSTANCE_ID } from '../../shared/session-key'
import { deriveLedger, ledgerIds } from '../../shared/session-ledger'
import { resolveResumeSessionId } from './useTabRestoration-resume'
import { restoredConversationStatus } from './useTabRestoration-status'
import { reconcileRestoredImages } from './useTabRestoration-images'
import { rDebug, rWarn, rError } from '../rendererLogger'

/**
 * Return true if the persisted message list contains a completed-plan marker.
 *
 * A plan is considered completed when the scrollback includes an
 * "── Implementing plan at …" divider (written by implementPlan
 * in implement-slice.ts when the user clicks Implement) OR the last
 * "── Plan created" divider is followed only by system messages, indicating
 * the model auto-exited and the approval card has not yet been actioned.
 *
 * For the restore guard we use the simpler sufficient condition: the presence
 * of an Implementing divider. If that divider is present, the user already
 * moved past the plan; there is no reason to re-enable plan mode on the engine.
 *
 * Exported for unit testing.
 */
export function hasPlanBeenImplemented(
  messages: PersistedConversationInstance['messages'],
): boolean {
  if (!messages || messages.length === 0) return false
  return messages.some(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('── Implementing plan at'),
  )
}

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Resolve the conversationId an extension-hosted tab should resume on restore.
 *
 * This is the root-cause fix for the "agent starts fresh after restart" data-loss
 * regression. The prior logic resolved only `inst.conversationIds[last]` →
 * `st.conversationId`; when both were empty it omitted `sessionId` from
 * `engineStart`, and the engine pre-minted a brand-new EMPTY conversation, which
 * the desktop then adopted as the tab's identity — orphaning the real
 * conversation on disk.
 *
 * Resolution priority (first non-empty wins):
 *   1. `inst.conversationIds[last]`  — the instance's most-recent conversation.
 *   2. `st.conversationId`           — the tab-level conversation id.
 *   3. `st.lastKnownSessionId`       — the last id the tab was ever bound to
 *                                      (survives even when conversationId was
 *                                      transiently cleared).
 *   4. `inst.conversationIds[0]`     — the oldest id in the instance chain, a
 *                                      last resort before giving up.
 *
 * Phantom-id guard (#230/#231): when an `exists` predicate is supplied, every
 * candidate is filtered through it so a "phantom" id — one pre-minted by the
 * engine on a prior restart and never saved (no backing file) — can NEVER be
 * selected. This is the desktop half of the phantom-resume fix: the morning's
 * data loss happened because an empty phantom got appended to `conversationIds`,
 * so `[last]` resolved to the newest phantom on every restart, the engine could
 * not load it, pre-minted another phantom, and the chain self-propagated.
 * Filtering by on-disk existence breaks the chain: we resolve to the most-recent
 * id that actually has a conversation file, skipping phantoms entirely.
 *
 * When `exists` is omitted (callers that cannot probe disk, or pure unit tests
 * of the raw priority order), the resolver falls back to the unfiltered walk —
 * preserving the original behavior. The restore caller always supplies `exists`.
 *
 * Returns '' only when NONE of these is available (or all candidates are
 * phantoms). A '' result must NOT be passed to engineStart as a fresh session —
 * see restoreSingleInstanceTab, which refuses the sessionless start when the
 * instance has persisted history.
 *
 * Exported for unit testing the resolution order at a stable seam.
 */
export function resolveRestoreSessionId(
  inst: Pick<PersistedConversationInstance, 'conversationIds'>,
  st: Pick<PersistedTab, 'conversationId' | 'lastKnownSessionId'>,
  exists?: (id: string) => boolean,
): string {
  const ids = inst.conversationIds ?? []

  // Apply the phantom guard when a predicate is supplied: a candidate only
  // counts if it is non-empty AND (no predicate given OR the file exists).
  const usable = (id: string | null | undefined): id is string =>
    !!id && (exists ? exists(id) : true)

  // Filter the instance chain to usable ids, preserving order. last/first are
  // taken from the FILTERED chain so a trailing phantom is skipped.
  const usableChain = ids.filter(usable)
  const last = usableChain.length > 0 ? usableChain[usableChain.length - 1] : ''
  const first = usableChain.length > 0 ? usableChain[0] : ''

  if (last) return last
  if (usable(st.conversationId)) return st.conversationId as string
  if (usable(st.lastKnownSessionId)) return st.lastKnownSessionId as string
  if (first) return first
  return ''
}

/**
 * Return true when an instance carries persisted conversational history that
 * would be orphaned by starting a fresh engine session. Used to decide whether
 * a missing conversationId is a hard data-loss condition (log + refuse the
 * minting start) or a benign empty tab (safe to start fresh).
 *
 * Exported for unit testing.
 */
export function instanceHasPersistedHistory(
  inst: Pick<PersistedConversationInstance, 'messages' | 'messageCount'>,
): boolean {
  if (inst.messages && inst.messages.length > 0) return true
  return (inst.messageCount ?? 0) > 0
}

/**
 * Decide whether a restored conversation pane should re-sync plan mode to the
 * engine after its session starts.
 *
 * The restored instance is always stored under MAIN_INSTANCE_ID:
 * `buildPopulatedInstance` normalizes the instance id (line ~330) and
 * `restoreSingleInstanceTab` sets `activeInstanceId: MAIN_INSTANCE_ID` (line
 * ~170). The PERSISTED instance id, however, may be a UUID (migrated
 * multi-instance tabs). A prior version of the resync block looked the
 * instance up by the persisted UUID id, so `find()` returned undefined and the
 * plan-mode resync was silently skipped — the local store showed plan mode but
 * the engine session ran in auto mode until the next prompt. This helper looks
 * the instance up by the normalized id it is actually stored under, matching
 * the activeInstanceId the pane carries.
 *
 * Exported for unit testing the resync decision at a stable seam (the pane
 * shape), independent of the full store / window.ion harness.
 */
export function restoredPaneWantsPlanMode(
  pane: { instances: Array<{ id: string; permissionMode?: 'auto' | 'plan' }> } | undefined,
): boolean {
  const inst = pane?.instances.find((i) => i.id === MAIN_INSTANCE_ID)
  return inst?.permissionMode === 'plan'
}

/**
 * Resolve the restored instance's plan file path for the plan-mode resync.
 *
 * Returns the `planFilePath` of the normalized-id ('main') instance, or
 * undefined when absent. Fed to `window.ion.engineSetPlanMode(key, true, path)`
 * on restore so the engine RE-ADOPTS the conversation's existing plan instead
 * of allocating a fresh slug on the next plan-mode prompt. Resolves the
 * instance the same way `restoredPaneWantsPlanMode` does (by the normalized id
 * the pane is stored under), so the gate and the path stay consistent.
 *
 * Exported for unit testing the path-forwarding decision at the same stable
 * seam (the pane shape) as the resync gate.
 */
export function restoredPlanFilePath(
  pane: { instances: Array<{ id: string; planFilePath?: string | null }> } | undefined,
): string | undefined {
  const inst = pane?.instances.find((i) => i.id === MAIN_INSTANCE_ID)
  return inst?.planFilePath || undefined
}


// ─── Multi-instance split migration ────────────────────────────────────────
//
// HISTORICAL: the renderer-side split logic has moved to the on-disk
// migration layer (tab-migration-split.ts / tab-migration-split-runner.ts).
// The on-disk runner splits multi-instance tabs BEFORE the renderer loads
// so by the time restoreConversationTab runs, every tab carries at
// most one instance.
//
// splitMultiInstanceTab splits a multi-instance persisted engine tab into N
// single-instance PersistedTab records. The on-disk migration
// (tab-migration-split-runner.ts) normally performs this split before the
// renderer loads the file, so the common restore path sees only
// single-instance tabs. The restore path below still calls this helper as a
// defensive last-line guard: if a multi-instance tab somehow survives the
// on-disk migration (the runner never ran for this profile, the file was
// not-unified/no-file, or verify failed and left the legacy file intact), the
// renderer splits it too and restores every instance as its own tab — no
// conversation history is dropped, even on the paths where no on-disk
// `.pre-split` backup exists.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Split a multi-instance persisted engine tab into N single-instance
 * PersistedTab records. Returns one PersistedTab per instance, each carrying
 * a single-instance conversationPane. The `_multiInstanceSplit` marker
 * prevents re-splitting.
 */
export function splitMultiInstanceTab(st: PersistedTab): {
  tabs: PersistedTab[]
  activeLocalIndex: number
} {
  const instances = st.conversationPane?.instances ?? []
  if (instances.length <= 1) {
    return { tabs: [st], activeLocalIndex: 0 }
  }

  const activeInstId = st.conversationPane?.activeInstanceId ?? instances[0].id
  let activeLocalIndex = 0

  const tabs: PersistedTab[] = instances.map((inst, i) => {
    if (inst.id === activeInstId) activeLocalIndex = i
    // Build a standalone tab for this instance. The instance becomes the
    // sole entry in a single-instance conversationPane.
    const singlePane: PersistedTab['conversationPane'] = {
      instances: [inst],
      activeInstanceId: inst.id,
    }

    return {
      ...st,
      // Each split tab gets the instance label as its custom title so the
      // user can distinguish them (the parent tab's title was shared).
      customTitle: inst.label || st.customTitle,
      // Conversation continuity: use the instance's most recent conversationId
      // as the tab-level conversationId (the parent tab's conversationId was
      // shared across all instances, which was always wrong for >1 instance).
      conversationId: inst.conversationIds?.[inst.conversationIds.length - 1] ?? st.conversationId,
      conversationPane: singlePane,
      // Mark as split so a second restore does not re-split.
      _multiInstanceSplit: true,
    } as PersistedTab & { _multiInstanceSplit: boolean }
  })

  return { tabs, activeLocalIndex }
}

/**
 * Restore an engine tab from a persisted `PersistedTab` snapshot.
 *
 * Single-instance-per-tab model (conversation unification #256, phase 1):
 * the on-disk split migration (tab-migration-split-runner.ts) flattens
 * multi-instance tabs before the renderer loads. By the time this function
 * runs, every tab should carry at most one instance.
 *
 * Defensive fallback: if a multi-instance tab somehow survives the on-disk
 * migration (e.g. the runner never ran for this profile, the file was
 * `not-unified`/`no-file`, or verify failed and left the legacy file
 * intact), we do NOT drop the extra instances. We split them in the
 * renderer too — via the same splitMultiInstanceTab used by the on-disk
 * migration — so each instance becomes its own standalone tab and no
 * conversation history is lost even on the paths where no on-disk
 * `.pre-split` backup exists (ADR-011).
 */
export async function restoreConversationTab(
  st: PersistedTab,
  restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }>,
  tabIndex: number,
): Promise<string> {
  const instances = st.conversationPane?.instances ?? []

  if (instances.length > 1) {
    rWarn('restore', 'multi-instance tab reached renderer, splitting', { tab_id: st.id?.slice(0, 8) ?? '', count: instances.length })

    // Split via the same helper the on-disk migration uses (preserves each
    // instance's title, conversationId, history, and per-instance state).
    // The first split tab becomes this tab — its id is returned for active-tab
    // continuity; the rest are appended. Every instance's history survives.
    const { tabs } = splitMultiInstanceTab(st)
    let firstTabId = ''
    for (let i = 0; i < tabs.length; i++) {
      const id = await restoreSingleInstanceTab(tabs[i], restoredTabIds, tabIndex + i)
      if (i === 0) firstTabId = id
    }
    return firstTabId
  }

  return restoreSingleInstanceTab(st, restoredTabIds, tabIndex)
}

/**
 * Restore a single-instance extension-hosted conversation. This is the core restore path,
 * called directly for single-instance tabs and per-tab for split results.
 *
 * Phase 2 (#256): now async. createConversationTab is async (calls window.ion.createTab()).
 * The caller (restoreConversationTab, and useTabRestoration.ts) awaits this.
 */
async function restoreSingleInstanceTab(
  st: PersistedTab,
  restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }>,
  tabIndex: number,
): Promise<string> {
  // Reuse the persisted, durable tabId when present so the session key is
  // invariant across restarts and the engine binding store resumes the same
  // conversation. Legacy persisted tabs have no `id`: mint a fresh one this
  // launch (reuseTabId undefined) — persistTabs writes the minted id, so it
  // stabilizes from the next save forward. This is the root-cause fix for the
  // restart-fragmentation defect (a new tabId per restart minted a new empty
  // engine conversation and split history across disjoint files).
  const tabId = await useSessionStore.getState().createConversationTab(st.workingDirectory, {
    profileId: st.engineProfileId || undefined,
    ...(st.id ? { reuseTabId: st.id } : {}),
  })
  restoredTabIds.push({ tabId, sessionId: null, index: tabIndex })

  // Build all engine state before any setState call to avoid intermediate
  // renders where EngineView sees no instances (its auto-create effect
  // would fire, causing duplicate sessions and cascading re-renders).
  const restoredPanes = new Map(useSessionStore.getState().conversationPanes)

  // The pane has at most 1 instance (single-instance model).
  const unifiedInstances = st.conversationPane?.instances ?? []
  // Restored tab status. createConversationTab sets
  // the tab to 'connecting' to show the connecting indicator for a NEW tab whose
  // session is about to come online. On RESTORE that is wrong: the session start
  // below is a warmup reconnect, not a user action, and nothing transitions the
  // tab out of 'connecting' — the engine goes straight to idle, and the control
  // plane suppresses that idle (its TabEntry is already idle), so no task_complete
  // is synthesized to clear the renderer. The tab would be stranded showing the
  // orange/connecting indicator + interrupt button, unable to accept input.
  //
  // The correct restored status reflects the restored conversation's resting
  // state, never 'connecting':
  //   - 'completed' when there is a restored pending card (an AskUserQuestion /
  //     ExitPlanMode denial or a non-empty permission queue) so the card renders
  //     and the user can respond — mirrors the live task_complete-with-denials
  //     status (engine-control-plane-events.ts) and the event-slice task_complete
  //     branch.
  //   - 'idle' otherwise.
  let restoredStatus: 'idle' | 'completed' = 'idle'
  if (unifiedInstances.length > 0) {
    // Only restore the first instance (single-instance-per-tab model).
    const inst = unifiedInstances[0]
    const populated = buildPopulatedInstance(inst, tabId, st)
    restoredStatus = restoredConversationStatus(populated)
    restoredPanes.set(tabId, {
      instances: [populated],
      // The restored instance id is normalized to MAIN_INSTANCE_ID (see
      // buildPopulatedInstance). Bare-key engine events resolve to 'main'
      // via parseSessionKey, so the active id must match or every
      // engine_status / agent-state / message write would miss the
      // instance (findIndex(-1) no-op). Migrated tabs persisted their
      // original UUID instance id; normalizing here heals that on load.
      activeInstanceId: MAIN_INSTANCE_ID,
    })
  }

  // Single atomic setState: tab metadata + conversationPanes.
  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tabId
        ? {
            ...t,
            customTitle: st.customTitle || null,
            pillColor: st.pillColor || null,
            groupId: st.groupId || null,
            groupPinned: st.groupPinned ?? false,
            conversationId: st.conversationId || null,
            lastMessagePreview: st.lastMessagePreview || null,
            lastEventAt: st.lastEventAt ?? null,
            permissionMode: 'auto',
            // Override the 'connecting' that createConversationTab set for the
            // new-tab connecting indicator. On restore the session start is a
            // warmup reconnect with no transition out of 'connecting'; the tab
            // must rest at its restored status instead of a stuck spinner.
            status: restoredStatus,
            // A restored tab has no in-flight run. Clear any stale request id so
            // the interrupt button is not shown and submit is not blocked.
            activeRequestId: null,
          }
        : t
    ),
    conversationPanes: restoredPanes,
  }))

  if (unifiedInstances.length > 0) {
    const { engineProfiles } = usePreferencesStore.getState()
    const profile = st.engineProfileId ? engineProfiles.find((p) => p.id === st.engineProfileId) : null
    if (profile) {
      const inst = unifiedInstances[0]
      const key = tabId
      // Resolve the conversation to resume (ledger-aware, phantom-guarded). See
      // resolveResumeSessionId — it prefers currentSessionId so a restart
      // resumes the SAME session and appends nothing (the restart-fragmentation
      // fix), falling back to the chain / tab id / lastKnownSessionId.
      const instSessionId = await resolveResumeSessionId(inst, st, (id) => window.ion.conversationExists(id))
      if (!instSessionId && instanceHasPersistedHistory(inst)) {
        // Hard data-loss condition: this instance has real scrollback but no
        // resolvable conversationId. Starting the engine here would mint a new
        // empty conversation and the engine_status first-bind would adopt it,
        // permanently orphaning the history. Refuse the minting start; the tab
        // lazy-resolves on the first prompt instead. Logged as an error so the
        // condition is observable rather than silent (the underlying
        // persistence gap is fixed in serialize-conversation-pane.ts).
        rError('restore', 'refusing sessionless engine start: instance has messages but no resolvable conversationId', { key, message_count: inst.messageCount ?? inst.messages?.length ?? 0, conversation_ids: inst.conversationIds?.length ?? 0, conversation_id: st.conversationId ?? '', last_known_session_id: st.lastKnownSessionId ?? '' })
        return tabId
      }
      // Seed the renderer tab's conversationId from the resolved id BEFORE the
      // start so the control-plane divergence guard (engine_status handler) has
      // the real id in hand when the engine emits its first idle status. Without
      // this, a freshly-restored tab whose TabEntry has no conversationId lets
      // the first-bind branch adopt whatever id the engine emits.
      if (instSessionId) {
        useSessionStore.setState((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId && !t.conversationId ? { ...t, conversationId: instSessionId } : t)),
        }))
      }
      try {
        await window.ion.engineStart(key, {
          profileId: profile.id,
          extensions: profile.extensions,
          workingDirectory: st.workingDirectory,
          ...(instSessionId ? { sessionId: instSessionId } : {}),
        })
        const pane = useSessionStore.getState().conversationPanes.get(tabId)
        if (restoredPaneWantsPlanMode(pane)) {
          // Forward the restored plan file path so the engine re-adopts the
          // existing plan instead of allocating a fresh slug on the next
          // prompt. Resolved via the same normalized-id seam as the gate.
          const restoredPlanPath = restoredPlanFilePath(pane)
          rDebug('restore', 'syncing plan mode to engine', { key, plan_file_path: restoredPlanPath ?? '' })
          window.ion.engineSetPlanMode(key, true, restoredPlanPath)
        }
      } catch (err: any) {
        rError('restore', 'engine start failed', { key, error: err?.message })
      }

      // Reconcile image attachments from the engine's authoritative history
      // onto the restored scrollback. Extension-hosted tabs restore from the
      // persisted desktop cache and never call load_session_history, so a
      // cache written without attachments (anything predating the desktop's
      // live image path) restores its tool rows with the inline images
      // stripped. reconcileRestoredImages loads flattenEntries — the only
      // reload path that re-derives image attachments from persisted image
      // blocks — and merges them onto the matching tool rows. See
      // useTabRestoration-images.ts.
      await reconcileRestoredImages(tabId, key, inst.conversationIds ?? [], st.conversationId, instSessionId)
    }
  }

  return tabId
}

/**
 * Build a fully-populated ConversationInstance from a persisted instance.
 * Handles message filtering, agent state coercion, denial synthesis, and
 * all per-instance field restoration.
 *
 * Exported for direct unit testing of the #256 Defect 1 fix: the returned
 * instance id is normalized to MAIN_INSTANCE_ID regardless of the persisted
 * (possibly UUID) id, so bare-key engine writes land on it.
 */
export function buildPopulatedInstance(
  inst: PersistedConversationInstance,
  tabId: string,
  _st: PersistedTab,
): ConversationRef & ConversationInstance {
  // Filter extension error messages from persisted scrollback.
  // Also drop legacy bootstrap markers (role:'harness', content starts with
  // 'Session bootstrapped:', no dedupKey). These accumulated before the
  // relocate dedup mode was introduced; they have no dedupKey so the
  // suppress-later path never collapsed them. Dropping them on restore
  // prevents the 5,712-object accumulation from surviving the next
  // serialize cycle. Keyed harness messages (dedupKey present) are kept.
  const LEGACY_BOOTSTRAP_PREFIX = 'Session bootstrapped:'
  const isLegacyBootstrapMarker = (m: { role?: string; content?: string; dedupKey?: string }) =>
    m.role === 'harness' &&
    (m.content || '').startsWith(LEGACY_BOOTSTRAP_PREFIX) &&
    !m.dedupKey
  const saved = (inst.messages ?? []).filter(
    (m) => !isExtensionErrorMessage({ role: m.role || '', content: m.content || '' }) && !isLegacyBootstrapMarker(m),
  )
  const restoredMessages: Message[] = saved.map((m) => ({
    id: crypto.randomUUID(),
    role: m.role as Message['role'],
    content: m.content || '',
    toolName: m.toolName,
    toolId: m.toolId,
    toolInput: m.toolInput,
    toolStatus: m.toolStatus as Message['toolStatus'],
    timestamp: m.timestamp,
    dedupKey: m.dedupKey,
    // Restore planFilePath on plan-lifecycle divider rows (Plan created /
    // Plan updated / Implementing plan) so the slug stays clickable after a
    // restart. The serializer persists it (serialize-conversation-pane.ts);
    // dropping it here would leave the divider text intact but break the link.
    planFilePath: m.planFilePath,
    slashCommand: m.slashCommand,
    slashArgs: m.slashArgs,
    slashSource: m.slashSource,
    // Restore engine-produced image attachments (tool-result / provider
    // images) so inline thumbnails survive a restart. The serializer persists
    // them (serialize-conversation-pane.ts); dropping them here would leave the
    // tool/assistant row intact but strip its images, because the restored
    // instance is non-empty and the skeleton lazy-load that re-fetches from the
    // engine never fires.
    attachments: m.attachments,
    // Seal all restored assistant messages so incoming engine_text_delta
    // events do not append to historical content (Defect 3). Historical
    // messages are definitionally complete; the engine writes to a new
    // message bubble for the next turn. Without sealed=true the last
    // assistant message absorbs the next turn's text, doubling both
    // the historical content and the new response in the same bubble.
    ...(m.role === 'assistant' ? { sealed: true } : {}),
  }))

  const agents = inst.agentStates
  const restoredAgents: AgentStateUpdate[] = (agents && agents.length > 0)
    ? agents.map((a) => ({
        name: a.name,
        ...(a.id ? { id: a.id } : {}),
        status: (a.status === 'running' ? 'done' : a.status) as AgentStateUpdate['status'],
        metadata: a.metadata,
      }))
    : []

  if (inst.draftInput && inst.draftInput.length > 0) {
    rDebug('restore', 'engine draft', { tab_id: tabId.slice(0, 8), inst_id: inst.id.slice(0, 8), count: inst.draftInput.length })
  }
  if (inst.modelOverride) {
    rDebug('restore', 'engine model override', { tab_id: tabId.slice(0, 8), inst_id: inst.id.slice(0, 8), model: inst.modelOverride })
  }

  // Resolve permission mode: use the instance-level value.
  // Guard: if the messages already contain an "Implementing plan" divider the
  // plan was completed before the app was restarted. Re-enabling plan mode on
  // the engine would emit a second "Plan created" divider and loop back into
  // plan mode instead of continuing in auto mode. Force 'auto' in that case
  // regardless of what was persisted (Defect 1 + Defect 2 root cause fix).
  let permMode: 'auto' | 'plan' = inst.permissionMode ?? 'auto'

  if (permMode === 'plan' && hasPlanBeenImplemented(inst.messages)) {
    rDebug('restore', 'plan mode cleared: already implemented', { tab_id: tabId.slice(0, 8), inst_id: inst.id.slice(0, 8) })
    permMode = 'auto'
  }

  // Resolve denied permission: authoritative from instance, then synthesize.
  let denied: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null = null
  if (inst.permissionDenied?.tools && inst.permissionDenied.tools.length > 0) {
    denied = { tools: inst.permissionDenied.tools }
    rDebug('restore', 'engine denial', { tab_id: tabId.slice(0, 8), inst_id: inst.id.slice(0, 8), tools: inst.permissionDenied.tools.map((t) => t.toolName).join(',') })
  } else {
    // Synthesize from message history (the engine reconcile only re-emits
    // from in-memory state; on restart that's empty).
    const msgs = inst.messages
    if (msgs && msgs.length > 0) {
      const outcome = pendingCardOutcome(msgs)
      if (outcome.kind === 'found') {
        denied = { tools: [{ toolName: outcome.toolName, toolUseId: outcome.toolId || 'restored', toolInput: parseToolInput(outcome.toolInput) }] }
        rDebug('restore', 'engine denial synthesized', { tab_id: tabId.slice(0, 8), inst_id: inst.id.slice(0, 8), tool: outcome.toolName })
      } else if (outcome.kind === 'suppressed-by-clear' || outcome.kind === 'suppressed-by-user') {
        rDebug('restore', 'engine denial suppressed', { tab_id: tabId.slice(0, 8), inst_id: inst.id.slice(0, 8), reason: outcome.kind })
      }
    }
  }

  return {
    // Normalize the restored instance id to MAIN_INSTANCE_ID. The unify
    // migration (tab-migration-unify.ts extensionInstances) persisted each
    // instance with its original engine-instance UUID, but the post-Phase-4b
    // invariant is that every conversation instance uses 'main' (the bare
    // session key parses to instanceId 'main'). Without this, the write-side
    // event handlers (withInstancePatch / withInstanceMessages /
    // withInstanceAgentStates) findIndex(i => i.id === 'main') and miss the
    // UUID instance, so status, streamed messages, and agent state never
    // update on restored migrated tabs. Only the id changes; all other
    // restored instance data (messages, conversationIds, agentStates,
    // permission state) is preserved.
    id: MAIN_INSTANCE_ID,
    label: inst.label,
    messages: restoredMessages,
    // When messages were persisted with content, messageCount mirrors the
    // restored length. When the instance was persisted count-only (no
    // renderer-only rows — harness/system — warranting content persistence),
    // inst.messages is absent and restoredMessages is empty; use the persisted
    // messageCount so the skeleton-detection logic (isSkeletonTab: messages
    // empty AND messageCount > 0) fires and lazy-load triggers correctly.
    messageCount: restoredMessages.length > 0 ? restoredMessages.length : (inst.messageCount ?? 0),
    modelOverride: inst.modelOverride || null,
    sessionModel: null,
    permissionMode: permMode,
    permissionDenied: denied,
    permissionQueue: [],
    elicitationQueue: [],
    // Rehydrate the runtime conversation chain from the session ledger when
    // present (the durable, reasoned source), falling back to the legacy
    // conversationIds array for pre-ledger files. ledgerIds(deriveLedger(...))
    // yields the same ordered id list either way.
    conversationIds: ledgerIds(deriveLedger(inst)),
    // Carry the reasoned ledger forward into the runtime instance so checkpoint
    // cut handlers append with the correct reason/parentId and the next persist
    // round-trips it. Empty for instances that have no sessions yet.
    sessions: deriveLedger(inst),
    draftInput: inst.draftInput || '',
    agentStates: restoredAgents,
    statusFields: null,
    // Restore the persisted plan file path so a plan-mode conversation keeps
    // continuity across restart. Previously hardcoded null, which dropped the
    // path on every extension-hosted tab restore and forced the next plan-mode
    // prompt to allocate a fresh slug — orphaning the conversation's real plan.
    planFilePath: inst.planFilePath ?? null,
    // Restore persisted dispatch telemetry so telemetry-only children (and the
    // nesting depth derived from them) survive reload. Absent on pre-fix files.
    dispatchTelemetry: inst.dispatchTelemetry ? [...inst.dispatchTelemetry] : [],
    forkedFromConversationIds: inst.forkedFromConversationIds ? [...inst.forkedFromConversationIds] : null,
    // Context breakdown is runtime-only: not persisted, populated from the first
    // engine_context_breakdown event after session resume. Initialize to null.
    contextBreakdown: null,
  }
}
