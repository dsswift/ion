import type { Message, AgentStateUpdate, ConversationInstance, ConversationRef } from '../../shared/types'
import type { PersistedTab } from '../../shared/types-persistence'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { isExtensionErrorMessage } from '../stores/session-store-persistence'
import { pendingCardOutcome } from '../../shared/pending-card'

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Restore an engine tab and all its per-instance state from a persisted
 * `PersistedTab` snapshot. Extracted from `useTabRestoration.ts` to
 * keep that file under the 600-line cap.
 *
 * Inputs:
 *   - `st`: the persisted tab record
 *   - `restoredTabIds`: the accumulator used by the caller to track
 *     which tabs were created so historical-message loading can
 *     iterate them later. Updated in-place.
 *   - `tabIndex`: the index of this tab in the persisted array (the
 *     caller uses this to associate the new tabId back to the
 *     original position so `saved.activeTabIndex` works).
 *
 * Side effects:
 *   - Calls `createEngineTab` on the session store (synchronous).
 *   - Performs a single atomic `setState` to seed conversationPanes with
 *     fully-populated ConversationInstance fields on each instance.
 *   - Issues async `window.ion.engineStart` calls per instance (the
 *     returned promises are not awaited — engines start in parallel).
 *
 * Returns the newly-created `tabId` so callers can link it.
 */
export function restoreEngineTab(st: PersistedTab, restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }>, tabIndex: number): string {
  const tabId = useSessionStore.getState().createEngineTab(st.workingDirectory, st.engineProfileId || undefined)
  restoredTabIds.push({ tabId, sessionId: null, index: tabIndex })

  // Build all engine state before any setState call to avoid
  // intermediate renders where EngineView sees no instances
  // (its auto-create effect would fire, causing duplicate sessions
  // and cascading re-renders → React error #310).
  //
  // All per-instance state is collected into local Maps here (keyed by
  // instanceId for easy lookup in populatedInstances below) and then
  // written directly onto each ConversationRef as ConversationInstance
  // fields. The 8 legacy Maps on the session store are no longer set
  // from this function — instance fields are the canonical source.
  const restoredPanes = new Map(useSessionStore.getState().conversationPanes)

  // Per-instance data — keyed by instanceId (not compound tabId:instanceId).
  const instanceMessages = new Map<string, Message[]>()
  const instanceAgentStates = new Map<string, AgentStateUpdate[]>()
  const instanceDraftInputs = new Map<string, string>()
  // Per-engine-instance pending denials. We deliberately do NOT
  // carry the legacy parent-level `st.permissionDenied` forward
  // for engine tabs — that field was written by the old slice
  // and would show a stale parent-card on every sibling. The
  // engine's reconcile handshake will repopulate the denial
  // per-instance authoritatively on the next engine_status.
  const instancePermissionDenied = new Map<string, { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }>()
  // Per-engine-instance conversation IDs. Seeded from the
  // persisted `engineSessionIds` so the engine restart can
  // pass the correct sessionId per instance (otherwise three
  // instances under the same tab all try to resume
  // `st.conversationId`, which is the parent tab's single ID
  // — a pre-existing bug). Also lets
  // useEnginePermissionDenialBackfill locate the right
  // conversation file immediately at startup instead of
  // waiting for engine_status to populate the entry.
  const instanceConversationIds = new Map<string, string[]>()
  const instanceModelOverrides = new Map<string, string>()
  const instancePermissionModes = new Map<string, 'auto' | 'plan'>()
  const instanceForkedChains = new Map<string, string[]>()

  // Read per-instance state from the unified conversationPane. Loaded tabs are
  // normalized to the unified shape (migrateTabToUnified) before restoration, so
  // every instance's messages / agentStates / denial / model / draft / session
  // ids / forked chains already live on the persisted ConversationInstance —
  // no `engine*` map lookups remain.
  const unifiedInstances = st.conversationPane?.instances ?? []
  if (unifiedInstances.length > 0) {
    for (const inst of unifiedInstances) {
      const saved = (inst.messages ?? []).filter(
        (m) => !isExtensionErrorMessage({ role: m.role || '', content: m.content || '' }),
      )
      if (saved.length > 0) {
        instanceMessages.set(inst.id, saved.map((m) => ({
          id: crypto.randomUUID(),
          role: m.role as Message['role'],
          content: m.content || '',
          toolName: m.toolName,
          toolId: m.toolId,
          toolInput: m.toolInput,
          toolStatus: m.toolStatus as Message['toolStatus'],
          timestamp: m.timestamp,
          dedupKey: m.dedupKey,
          slashCommand: m.slashCommand,
          slashArgs: m.slashArgs,
          slashSource: m.slashSource,
        })))
      }

      const agents = inst.agentStates
      if (agents && agents.length > 0) {
        instanceAgentStates.set(inst.id, agents.map((a) => ({
          name: a.name,
          ...(a.id ? { id: a.id } : {}),
          status: (a.status === 'running' ? 'done' : a.status) as AgentStateUpdate['status'],
          metadata: a.metadata,
        })))
      }

      if (inst.draftInput && inst.draftInput.length > 0) {
        instanceDraftInputs.set(inst.id, inst.draftInput)
        console.log(`[restore] engine draft for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} len=${inst.draftInput.length}`)
      }

      if (inst.permissionDenied && inst.permissionDenied.tools && inst.permissionDenied.tools.length > 0) {
        instancePermissionDenied.set(inst.id, { tools: inst.permissionDenied.tools })
        console.log(`[restore] engine denial for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} tools=${inst.permissionDenied.tools.map((t) => t.toolName).join(',')}`)
      }

      // Seed per-instance conversation IDs from persistence so the engine
      // restart can pass the correct sessionId per instance (and backfill can
      // locate the conversation file). engine_status appends more at runtime.
      if (inst.conversationIds && inst.conversationIds.length > 0) {
        instanceConversationIds.set(inst.id, [...inst.conversationIds])
      }

      if (inst.modelOverride) {
        instanceModelOverrides.set(inst.id, inst.modelOverride)
        console.log(`[restore] engine model override for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} model=${inst.modelOverride}`)
      }

      if (inst.permissionMode) {
        instancePermissionModes.set(inst.id, inst.permissionMode)
      } else if (st.permissionMode === 'plan') {
        // Back-compat: a legacy parent-level 'plan' applied to all instances.
        instancePermissionModes.set(inst.id, 'plan')
      }

      if (inst.forkedFromConversationIds && inst.forkedFromConversationIds.length > 0) {
        instanceForkedChains.set(inst.id, inst.forkedFromConversationIds)
      }
    }

    // Fallback: synthesize a denial from the last tool message in each
    // instance's persisted messages when the engine hasn't replayed a denial.
    //
    // Why this matters: the engine's reconcile_state only re-emits pending
    // denials from in-memory state. On engine restart that slice is empty and
    // the desktop loses the card even though the conversation file shows the
    // assistant's final AskUserQuestion / ExitPlanMode call. Mirrors the
    // plain-conversation path which scans historical messages.
    //
    // We synthesize only when the instance has no authoritative denial AND the
    // last pending-card tool is genuinely still outstanding (no trailing /clear
    // divider, no trailing user message) — the shared pending-card rule. This is
    // the resurrected-card-bug fix: a conversation cleared after its last
    // question must NOT rebuild the card from history.
    for (const inst of unifiedInstances) {
      if (instancePermissionDenied.get(inst.id)) continue
      const msgs = inst.messages
      if (!msgs || msgs.length === 0) continue
      const outcome = pendingCardOutcome(msgs)
      if (outcome.kind !== 'found') {
        if (outcome.kind === 'suppressed-by-clear' || outcome.kind === 'suppressed-by-user') {
          console.log(`[restore] engine denial suppressed for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} reason=${outcome.kind}`)
        }
        continue
      }
      instancePermissionDenied.set(inst.id, {
        tools: [{
          toolName: outcome.toolName,
          toolUseId: outcome.toolId || 'restored',
          toolInput: parseToolInput(outcome.toolInput),
        }],
      })
      console.log(`[restore] engine denial synthesized from history for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} tool=${outcome.toolName} toolId=${(outcome.toolId || 'none').slice(0, 16)} hasInput=${outcome.toolInput ? 'yes' : 'no'}`)
    }

    // Build pane instances with fully-populated ConversationInstance fields.
    // All per-instance data was collected into the local Maps above.
    // Components that read from instance fields see correct initial values
    // without waiting for the first engine event (issue #203).
    const populatedInstances: Array<ConversationRef & ConversationInstance> = unifiedInstances.map((inst) => {
      const restoredMessages = instanceMessages.get(inst.id) || []
      return {
        id: inst.id,
        label: inst.label,
        messages: restoredMessages,
        messageCount: restoredMessages.length,  // persisted-count proxy mirrors loaded messages
        modelOverride: instanceModelOverrides.get(inst.id) || null,
        sessionModel: null,   // populated on first engine_status event
        permissionMode: (instancePermissionModes.get(inst.id) || 'auto') as 'auto' | 'plan',
        permissionDenied: instancePermissionDenied.get(inst.id) || null,
        permissionQueue: [],  // live requests are re-emitted by the engine reconcile handshake
        conversationIds: instanceConversationIds.get(inst.id) || [],
        draftInput: instanceDraftInputs.get(inst.id) || '',
        agentStates: instanceAgentStates.get(inst.id) || [],
        statusFields: null,   // populated on first engine_status event
        planFilePath: null,   // populated on first engine_plan_mode_changed event
        forkedFromConversationIds: instanceForkedChains.get(inst.id) || null,
      }
    })
    restoredPanes.set(tabId, {
      instances: populatedInstances,
      activeInstanceId: unifiedInstances[0].id,
    })
  }

  // Single atomic setState: tab metadata + conversationPanes with fully-populated instances.
  // Instance fields (messages, agentStates, permissionDenied, etc.) are written onto
  // each instance directly — the legacy per-Map keys are not seeded here.
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
            // NB: modelOverride and draftInput are no longer TabState fields —
            // they live on each ConversationInstance in conversationPanes and were
            // seeded into populatedInstances above (modelOverride from
            // st.engineModelOverrides, draftInput from st.engineDrafts).
            // Keep tab.permissionMode at 'auto' for engine tabs — per-instance
            // modes live on each instance in conversationPanes. The parent tab's
            // permissionMode is only meaningful for CLI tabs.
            permissionMode: 'auto',
            // NB: deliberately NOT restoring st.permissionDenied
            // for engine tabs — legacy field, now superseded by
            // instance.permissionDenied. See comment above.
          }
        : t
    ),
    conversationPanes: restoredPanes,
  }))
  // (Per-instance engine drafts are logged in the collection loop above; the
  // parent tab carries no conversation draft for an extension-hosted tab.)

  // Start engine processes (state is fully set up)
  if (unifiedInstances.length > 0) {
    const { engineProfiles } = usePreferencesStore.getState()
    const profile = st.engineProfileId ? engineProfiles.find((p) => p.id === st.engineProfileId) : null
    if (profile) {
      for (const inst of unifiedInstances) {
        const key = `${tabId}:${inst.id}`
        // Prefer the per-instance sessionId (most recent conversation id for
        // this instance, from the unified instance's conversationIds). Fall
        // back to the parent tab.conversationId only for legacy back-compat —
        // in that case instances share one conversation (the old behavior).
        const instSessionId = inst.conversationIds?.[inst.conversationIds.length - 1] || st.conversationId || ''
        window.ion.engineStart(key, {
          profileId: profile.id,
          extensions: profile.extensions,
          workingDirectory: st.workingDirectory,
          ...(instSessionId ? { sessionId: instSessionId } : {}),
        }).then(() => {
          // Sync plan mode to the engine after the session exists.
          // Read from the per-instance permissionMode on the pane instance
          // (seeded into populatedInstances above). The engine creates
          // fresh sessions with planMode=false; without this sync, a restored
          // plan-mode instance loses its engine plan mode state until the next
          // submitEnginePrompt fires.
          const pane = useSessionStore.getState().conversationPanes.get(tabId)
          const restoredInst = pane?.instances.find((i) => i.id === inst.id)
          if (restoredInst?.permissionMode === 'plan') {
            console.log(`[restore] syncing plan mode to engine for ${key}`)
            window.ion.engineSetPlanMode(key, true)
          }
        }).catch((err: { message?: string }) => {
          console.error(`[restore] engine start failed for ${key}: ${err.message}`)
        })
      }
    }
  }

  return tabId
}
