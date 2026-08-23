/**
 * remote-projection — pure renderer-side projection of the session store onto
 * the remote-snapshot tab shape (`ProjectedRendererTab[]`).
 *
 * This is the extracted, importable replacement for the ~300-line
 * `executeJavaScript` IIFE that used to live as a string inside
 * main/remote/snapshot.ts. The IIFE ran in the renderer global scope via a
 * 5 s main-process poll; it could not import helpers (every shared predicate
 * had to be inlined and kept in sync by comment), was invisible to the type
 * checker, untestable except by regex-scanning its source string, and its
 * console.* calls violated ADR-019. As a real module it imports the canonical
 * helpers directly, is unit-tested, and logs through rendererLogger.
 *
 * Field contract: the output mirrors EXACTLY what the IIFE produced —
 * field-for-field — because the main-process mapping (snapshot.ts →
 * projectRendererTab) and the iOS wire shape (RemoteTabState) are pinned to
 * it. The snapshot-*-parity test suites assert this contract directly against
 * this function's output.
 *
 * Purity: no store access, no IPC, no window globals. The caller
 * (remote-projection-push.ts) passes the store state; tests pass fixtures.
 */

import type {
  ProjectedRendererTab,
  ProjectedPermissionEntry,
  ProjectedConversationInstance,
  ResourceManifest,
  RemoteTabStatesPayload,
} from '../../shared/remote-projection-types'
import type { TabState, TerminalPaneState } from '../../shared/types'
import type { ConversationPane, ResourceItem } from '../../shared/types-engine'
import { tabHasExtensions } from '../../shared/tab-predicates'
import { settlingIsPermanent } from '../../shared/worktree-conversations'
import { effectiveRunningChildrenCount, waitingStateOfPane } from '../components/TabStripShared'
import { classifyInbox, inboxUnread, wokeAt } from '../../shared/inbox-classify'
import { liveBackgroundShellCount } from '../../shared/background-shell-counts'
import { usePreferencesStore } from '../preferences'
import { rDebug } from '../rendererLogger'

/**
 * The slice of session-store state the projection reads. Structural subset of
 * the full store State so tests can build minimal fixtures and the Studio mirror
 * store satisfies it too (though the mirror never pushes — see
 * remote-projection-push.ts).
 */
export interface ProjectionStoreState {
  tabs: TabState[]
  terminalPanes: Map<string, TerminalPaneState>
  conversationPanes: Map<string, ConversationPane>
  resources: Record<string, ResourceItem[]>
  readResourceIds: Set<string>
  engineModelFallbacks: Map<string, { requestedModel: string; fallbackModel: string; reason: string; at: number }>
  /** Canonical tail-fingerprint accessor exposed by engine-slice-submit. */
  computeConvFingerprint: (tabId: string) => string
}

/**
 * Project the resource metadata manifest from the store's resource maps.
 * Mirrors the IIFE's resourceManifest block: per-kind arrays of id/kind/
 * title/createdAt/read/conversationId.
 */
export function projectResourceManifest(s: Pick<ProjectionStoreState, 'resources' | 'readResourceIds'>): ResourceManifest {
  const resources = s.resources || {}
  const readIds = s.readResourceIds instanceof Set ? s.readResourceIds : new Set<string>()
  const manifest: ResourceManifest = {}
  for (const kind of Object.keys(resources)) {
    manifest[kind] = (resources[kind] || []).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title || '',
      createdAt: r.createdAt,
      read: readIds.has(r.id),
      conversationId: r.conversationId || undefined,
    }))
  }
  return manifest
}

/**
 * Project the full remote-snapshot payload (tabs + resource manifest) from
 * store state. Pure — the caller owns subscription, debounce, and IPC.
 */
export function projectRemoteTabStates(s: ProjectionStoreState): RemoteTabStatesPayload {
  const resourceManifest = projectResourceManifest(s)
  const tabs = s.tabs.map((t) => projectTab(t, s))
  return { tabs, resourceManifest }
}

/** Statuses whose stale permissionDenied residue must NOT be promoted. */
function isDenialPromotionSuppressed(status: string): boolean {
  // Running/connecting tabs have no outstanding permission question: a
  // genuine mid-run request arrives via the live permissionQueue /
  // permission_request path, not the stale permissionDenied residue.
  // permissionDenied is cleared lazily (only on next send when !isBusy —
  // send-slice.ts), so a running tab holds a resolved denial and promoting
  // it would re-inject a stale card on iOS on every snapshot push.
  return status === 'failed' || status === 'dead' || status === 'running' || status === 'connecting'
}

function projectTab(t: TabState, s: ProjectionStoreState): ProjectedRendererTab {
  // Resolve the ACTIVE conversation instance once. Every tab (plain or
  // extension-hosted) stores messages / permissionDenied / permissionQueue /
  // permissionMode on a ConversationInstance in conversationPanes (a plain
  // conversation has a single 'main' instance). This is the unified read
  // source; no tab-level fork.
  const cPane = s.conversationPanes.get(t.id) ?? null
  const activeInstId = cPane ? (cPane.activeInstanceId || cPane.instances[0]?.id || null) : null
  const activeInst = (activeInstId && cPane) ? cPane.instances.find((i) => i.id === activeInstId) ?? null : null

  const msgs = activeInst?.messages ?? []

  // Inbox classification (desktop computes, clients render). The waiting/
  // pending inputs mirror useInboxPartition's derivation over the pane.
  const nowMs = Date.now()
  const inboxView = {
    status: t.status,
    settledOverride: t.settledOverride,
    settledAt: t.settledAt,
    snoozedUntil: t.snoozedUntil,
    snoozedAt: t.snoozedAt,
    lastVisitedAt: t.lastVisitedAt,
    lastCompletionAt: t.lastCompletionAt,
    lastMessageAt: t.lastMessageAt,
    lastActivityAt: t.lastActivityAt,
    manualUnread: t.manualUnread,
    pendingAskCount: (activeInst?.permissionQueue.length ?? 0) + (activeInst?.elicitationQueue.length ?? 0),
    waiting: waitingStateOfPane(cPane ?? undefined) !== null,
    failed: t.status === 'failed',
    hasPendingWork: activeInst?.statusFields?.hasPendingWork === true
      || (activeInst?.statusFields?.backgroundAgents ?? 0) > 0
      || liveBackgroundShellCount(activeInst?.statusFields) > 0
      || activeInst?.agentStates.some((agent) => agent.status === 'running') === true,
  }
  const autoSettleDaysPref = usePreferencesStore.getState().inboxAutoSettleDays
  const inboxState = classifyInbox(inboxView, nowMs, autoSettleDaysPref > 0 ? autoSettleDaysPref : null)
  // lastMsg (the tab-list preview text) comes from the last user/assistant
  // row — a tool row has no useful preview string.
  let lastMsg: string | null = null
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' || msgs[i].role === 'user') {
      lastMsg = (msgs[i].content || '').substring(0, 100)
      break
    }
  }
  // A trailing tool can still be doing work after the last assistant text, so
  // the snapshot's activity timestamp must include every transcript row.
  const lastActivityTs = msgs.reduce((latest, message) => Math.max(latest, message.timestamp || 0), 0)

  // Conversation tail fingerprint — the staleness signal for the iOS
  // main-conversation heal. iOS computes the SAME fingerprint over its local
  // tail and reloads when it diverges (dropped live deltas). Routed through
  // the store's computeConvFingerprint, which calls the canonical
  // conversationTailFingerprint() from shared/conversation-fingerprint.ts —
  // the single TS source of truth, unit-tested separately. The Swift copy
  // (SessionViewModel+Snapshot.swift conversationTailFingerprint) must remain
  // byte-identical; any algorithm change starts there.
  const convFingerprint = typeof s.computeConvFingerprint === 'function'
    ? (s.computeConvFingerprint(t.id) || '')
    : ''

  // Live interactive permission requests live on the active instance.
  const queue: ProjectedPermissionEntry[] = (activeInst?.permissionQueue ?? []).slice()
  // Live extension elicitations (ctx.elicit) also live on the active
  // instance; project them so iOS can render an approval card and the run is
  // not silently parked on a mobile client.
  const elicitQueue = (activeInst?.elicitationQueue ?? []).slice()

  // Promote the active instance's non-interactive denials into the queue so
  // the iOS card path (which keys off the tab-level queue) works uniformly
  // for every tab. An extension-hosted tab stamps the promoted entry with
  // instanceId so iOS can scope the card to the owning sub-conversation; a
  // plain conversation's single main instance carries the denial and omits
  // the scope (so the iOS active-instance filter passes). The per-instance
  // waitingState (set below on conversationInstances[i]) drives the iOS
  // sub-tab pill; the parent pill glows because the denial is in the queue.
  // TAB-TYPE-AGNOSTIC for idle/completed: a plain conversation can run
  // background sub-agents whose denials must still reach iOS after the run
  // finishes — do NOT weaken the idle/completed promotion path.
  if (activeInst && !isDenialPromotionSuppressed(t.status)) {
    const pdTools = activeInst.permissionDenied?.tools
    if (pdTools && pdTools.length > 0) {
      for (const pd of pdTools) {
        // TAB-TYPE-AGNOSTIC: every outstanding denial surfaces to the iOS
        // card queue, plain or extension-hosted. A plain conversation can run
        // background sub-agents that produce non-plan tool denials, so a
        // completed plain conversation's denials must reach iOS too. (A prior
        // filter dropped all but ExitPlanMode / AskUserQuestion denials for
        // completed plain conversations — fixed.)
        const pdEntryOut: ProjectedPermissionEntry = {
          questionId: 'denied-' + pd.toolUseId,
          toolName: pd.toolName,
          toolTitle: pd.toolName,
          toolInput: pd.toolInput,
          options: [],
        }
        if (tabHasExtensions(t)) pdEntryOut.instanceId = activeInstId
        queue.push(pdEntryOut)
      }
    }
  }
  // Log when a running/connecting tab's denial promotion is suppressed so the
  // skip is observable in desktop.jsonl without ambiguity. (Was a console.log
  // inside the IIFE — an ADR-019 violation; now a structured rDebug.)
  if (activeInst && (t.status === 'running' || t.status === 'connecting')) {
    const pdSkipTools = activeInst.permissionDenied?.tools
    if (pdSkipTools && pdSkipTools.length > 0) {
      rDebug('remote-projection', 'suppressed stale denial promotion', {
        tab_id: t.id.slice(0, 8),
        status: t.status,
        tools: pdSkipTools.map((p) => p.toolName + '(' + p.toolUseId.slice(-8) + ')').join(','),
      })
    }
  }

  const pane = s.terminalPanes.get(t.id) ?? null
  let terminalInstances: ProjectedRendererTab['terminalInstances']
  let activeTerminalInstanceId: string | undefined
  if (pane && pane.instances && pane.instances.length > 0) {
    terminalInstances = pane.instances.map((inst) => ({
      id: inst.id,
      label: inst.label || 'Shell',
      kind: inst.kind || 'user',
      readOnly: !!inst.readOnly,
      cwd: inst.cwd || t.workingDirectory,
    }))
    activeTerminalInstanceId = pane.activeInstanceId || pane.instances[0].id
  }

  // Reuse the active-instance resolution from above. cPane is the tab's
  // conversation pane (every tab has one); list its instances so iOS can
  // render the per-sub-tab EngineInstanceBar.
  let conversationInstances: ProjectedConversationInstance[] | undefined
  let activeConversationInstanceId: string | undefined
  if (cPane && cPane.instances.length > 0) {
    conversationInstances = cPane.instances.map((inst) => {
      // Derive the instance's individual waitingState from permissionDenied
      // so iOS can show a per-sub-tab status dot in EngineInstanceBar.
      // 'question' outranks 'plan-ready' (matches desktop's getWaitingState).
      let ws: 'plan-ready' | 'question' | null = null
      const pdTools = inst.permissionDenied?.tools
      if (pdTools && pdTools.length > 0) {
        let hasPlanReady = false
        for (const pd of pdTools) {
          if (pd.toolName === 'AskUserQuestion') { ws = 'question'; break }
          if (pd.toolName === 'ExitPlanMode') hasPlanReady = true
        }
        if (ws === null && hasPlanReady) ws = 'plan-ready'
      }
      // Per-instance running state so iOS EngineInstanceBar can show a
      // pulsing dot on each running sub-tab.
      const st = inst.statusFields?.state
      const instRunning = st === 'running' || st === 'connecting'
      const instStarting = st === 'starting'
      // Per-instance running-agent-count via the CANONICAL helper
      // (effectiveRunningChildrenCount, TabStripShared.ts) — max of
      // agentStates and statusFields.backgroundAgents, because the two
      // observe the same underlying agents from two vantage points:
      // agentStates for extension-hosted orchestrators, backgroundAgents for
      // plain-conversation dispatches where agentStates remains empty.
      // The legacy IIFE inlined this logic with a keep-in-sync comment
      // because it could not import; as a real module we import it, so the
      // two can no longer drift. Drives the yellow "awaiting children" pulse
      // on the iOS sub-tab pill and footer. Per AGENTS.md § "Common parity
      // surfaces": when the desktop renders a per-instance signal, iOS must
      // see the same data through the snapshot.
      const instRunningAgents = effectiveRunningChildrenCount(inst)
      // Live background bash processes for this instance, notifying or
      // detached. iOS renders a pink shell dot and an "N background shells"
      // label from it; the tab aggregate below drives the parent pill's dot.
      // Reads liveBackgroundShellCount rather than the engine's notify-only
      // `backgroundShells` scalar so a detached command does not project as a
      // finished conversation — see shared/background-shell-counts.ts.
      const instBackgroundShells = liveBackgroundShellCount(inst.statusFields)
      // Per-instance model-fallback indicator. Projects the renderer's
      // engineModelFallbacks map onto each instance so iOS can render a
      // matching ⚠ glyph on its EngineInstanceBar. We forward only the
      // requested + fallback model strings (no timestamp, no reason — iOS
      // doesn't need them to render the indicator). When the snapshot
      // arrives with the field omitted, the iOS indicator clears — matching
      // the desktop's clear-on-idle behaviour. See AGENTS.md § "Common
      // parity surfaces" row for model fallback indicator.
      const mf = s.engineModelFallbacks.get(t.id + ':' + inst.id)
      const mfOut = mf ? { requestedModel: mf.requestedModel, fallbackModel: mf.fallbackModel } : undefined
      return {
        id: inst.id,
        label: inst.label,
        waitingState: ws,
        isRunning: instRunning || undefined,
        isStarting: instStarting || undefined,
        runningAgentCount: instRunningAgents > 0 ? instRunningAgents : undefined,
        backgroundShellCount: instBackgroundShells > 0 ? instBackgroundShells : undefined,
        activeBackgroundTasks: inst.statusFields?.activeBackgroundTasks?.length
          ? inst.statusFields.activeBackgroundTasks
          : undefined,
        hasPendingWork: inst.statusFields?.hasPendingWork || undefined,
        modelFallback: mfOut,
        conversationIds: inst.conversationIds && inst.conversationIds.length > 0 ? inst.conversationIds : undefined,
        thinkingEffort: (inst.thinkingEffort && inst.thinkingEffort !== 'off') ? inst.thinkingEffort : undefined,
        dispatchTelemetry: inst.dispatchTelemetry && inst.dispatchTelemetry.length > 0 ? inst.dispatchTelemetry : undefined,
      }
    })
    activeConversationInstanceId = cPane.activeInstanceId || cPane.instances[0].id
  }

  // Parallel aggregate for "any instance has running background children" —
  // drives the iOS parent tab pill's yellow "awaiting children" dot. Folds
  // across the per-instance runningAgentCount derived above.
  let anyInstanceHasRunningChildren = false
  if (conversationInstances) {
    for (const ci of conversationInstances) {
      if ((ci.runningAgentCount || 0) > 0) { anyInstanceHasRunningChildren = true; break }
    }
  }

  // Parallel aggregate for background bash commands — drives the iOS parent
  // tab pill's pink shell dot. SUMMED rather than max'd across instances:
  // separate instances run separate shell processes, so the counts add.
  let backgroundShellCount = 0
  if (conversationInstances) {
    for (const ci of conversationInstances) {
      backgroundShellCount += ci.backgroundShellCount || 0
    }
  }

  let hasPendingWork = false
  if (cPane) {
    hasPendingWork = cPane.instances.some((inst) => inst.statusFields?.hasPendingWork === true)
  }

  const sf = activeInst?.statusFields ?? null
  // runCostUsd: prefer the live run-scoped cost from statusFields; fall back
  // to the final task_complete cost from lastResult. Omitted when neither is
  // present (never-run tabs).
  const liveCost = typeof sf?.runCostUsd === 'number' ? sf.runCostUsd : undefined
  const runCostUsd = liveCost !== undefined
    ? liveCost
    : (typeof t.lastResult?.totalCostUsd === 'number' ? t.lastResult.totalCostUsd : undefined)
  // conversationTurns: lifetime prompt count. Prefer the live status field;
  // fall back to lastResult so historical/idle tabs still carry it.
  const liveTurns = typeof sf?.conversationTurns === 'number' ? sf.conversationTurns : undefined
  const conversationTurns = liveTurns !== undefined
    ? liveTurns
    : (typeof t.lastResult?.conversationTurns === 'number' ? t.lastResult.conversationTurns : undefined)
  const usage = t.lastResult?.usage
  const lastRunDurationMs = typeof t.lastResult?.durationMs === 'number'
    ? t.lastResult.durationMs
    : undefined
  const lastRunReason = t.lastResult?.reason

  // Per-conversation extended-thinking effort from the active instance.
  // Omitted when 'off'/absent so the iOS control defaults to off.
  const eff = activeInst?.thinkingEffort
  const thinkingEffort = (eff && eff !== 'off') ? eff : undefined

  return {
    id: t.id,
    title: t.title,
    customTitle: t.customTitle,
    // WI-001 (8690aae3) makes t.status authoritative for every conversation.
    // The normalized arm writes status to the single main instance with no
    // active-instance gate, so t.status is never stranded by an inactive
    // sub-instance switch. Status projects uniformly for all tabs.
    status: t.status,
    workingDirectory: t.workingDirectory,
    // All tab types store permissionMode on the active conversation instance
    // (WI-002). The activeInst resolution above is the single read source —
    // no tab-type fork.
    permissionMode: activeInst?.permissionMode || 'auto',
    permissionQueue: queue,
    elicitationQueue: elicitQueue,
    thinkingEffort,
    contextTokens: t.contextTokens,
    contextWindow: t.contextWindow ?? null,
    messageCount: msgs.length > 0 ? msgs.length : (activeInst?.messageCount || 0),
    queuedPrompts: t.queuedPrompts || [],
    isTerminalOnly: t.isTerminalOnly || undefined,
    inputLocked: t.inputLocked || undefined,
    inputLockReason: t.inputLockReason || undefined,
    tabRole: t.tabRole || undefined,
    hasEngineExtension: tabHasExtensions(t) || undefined,
    // iOS resolves the harness badge display name by matching engineProfileId
    // against the desktop_engine_profiles list. Without this field, the badge
    // falls back to literal "EXT".
    engineProfileId: t.engineProfileId || null,
    conversationInstances,
    activeConversationInstanceId,
    terminalInstances,
    activeTerminalInstanceId,
    groupId: t.groupId || null,
    modelOverride: activeInst?.modelOverride || null,
    groupPinned: t.groupPinned || false,
    // Top-level aggregate of "any sub-instance has running background
    // children". iOS reads this on the parent tab pill so the yellow
    // "awaiting children" dot fires without folding across
    // conversationInstances client-side.
    hasRunningChildren: anyInstanceHasRunningChildren || undefined,
    // Top-level sum of outstanding background bash commands across instances.
    // iOS reads it on the parent tab pill for the pink shell dot.
    backgroundShellCount: backgroundShellCount > 0 ? backgroundShellCount : undefined,
    hasPendingWork: hasPendingWork || undefined,
    conversationId: t.conversationId || null,
    lastMessageContent: lastMsg,
    // The remote activity clock must include run completion. A tool-only tail
    // can finish after the last user/assistant message, and both iOS and the
    // cold snapshot must show that true stop time.
    lastActivityTs: Math.max(lastActivityTs, t.lastActivityAt ?? 0, t.lastMessageAt ?? 0, t.lastCompletionAt ?? 0),
    idleSince: t.idleSince ?? null,
    createdAt: t.createdAt,
    // Explicit worktree identity so clients group without path guessing.
    // A worktree tab groups under worktree.repoPath even before the
    // inventory learns about the directory.
    worktree: t.worktree ? {
      worktreePath: t.worktree.worktreePath,
      branchName: t.worktree.branchName,
      sourceBranch: t.worktree.sourceBranch,
      repoPath: t.worktree.repoPath,
      landedAt: t.worktree.landedAt,
    } : undefined,
    inboxState,
    unread: inboxUnread(inboxView),
    snoozedUntil: t.snoozedUntil ?? null,
    settledAt: t.settledAt ?? null,
    // Stated, never inferred by the client: an ephemeral role settles
    // permanently. Only the blocking answer is sent — a client reads an absent
    // value as restorable, which is the default for every ordinary tab.
    canRestoreSettled: settlingIsPermanent(t.tabRole) ? false : undefined,
    wokeAt: wokeAt(inboxView, nowMs),
    pinnedAt: t.pinnedAt,
    pinOrderKey: t.pinOrderKey,
    backgroundLiveness: anyInstanceHasRunningChildren
      ? 'working'
      : backgroundShellCount > 0
        ? 'monitoring'
        : undefined,
    convFingerprint,
    pillColor: t.pillColor || null,
    pillIcon: t.pillIcon || null,
    // ─── Cold-start parity: cost + token fields ─────────────────────────
    // Projected from the active-instance statusFields and lastResult so iOS
    // has accurate cost/token data on cold open without waiting for a live
    // engine_status event.
    runCostUsd,
    conversationCostUsd: typeof sf?.conversationCostUsd === 'number' ? sf.conversationCostUsd : undefined,
    conversationTurns,
    lastRunDurationMs,
    lastRunReason,
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
    cacheReadTokens: typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
    cacheCreationTokens: typeof usage?.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
  }
}
