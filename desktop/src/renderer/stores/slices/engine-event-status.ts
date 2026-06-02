import type { StoreSet } from '../session-store-types'
import type { EngineEvent } from '../../../shared/types'

/**
 * Handler for `engine_status` events on engine-view tabs (compound
 * `${tabId}:${instanceId}` key). Extracted from engine-event-slice.ts
 * to keep that file under the 600-line TypeScript cap.
 *
 * Behavior:
 *   - Merges the engine_status payload into `engineStatusFields`,
 *     carrying forward last-known context/cost values so footers
 *     don't blink to zero on cost-only ticks.
 *   - Captures new sessionIds into `engineConversationIds` and signals
 *     the caller (via the returned `didCaptureNewSessionId` flag) so it
 *     can trigger an immediate persistence flush — this is what makes
 *     the conversation chain survive a hard kill.
 *   - Promotes AskUserQuestion / ExitPlanMode permissionDenials into
 *     `enginePermissionDenied`, preserving prior entries on cost-only
 *     follow-up ticks so the card doesn't flicker out.
 *   - Updates the parent tab's `conversationId` and `status` when the
 *     instance is the active one (mid-pane). Status transitions: idle
 *     state with interesting denials → 'completed'; idle without →
 *     'idle'; running → 'running'.
 *
 * The active-instance gate matches the rest of engine-event-slice.ts:
 * we never overwrite the outer tab's status from an inactive instance
 * because the outer tab pill reflects whichever sub-conversation the
 * user is currently looking at.
 */
export function handleEngineStatusEvent(
  set: StoreSet,
  key: string,
  tabId: string,
  event: Extract<EngineEvent, { type: 'engine_status' }>,
): { didCaptureNewSessionId: boolean } {
  // Track whether the inside-`set` reducer captured a new sessionId into
  // engineConversationIds — if so, the caller triggers an immediate
  // persistence flush after the reducer returns so the sessionId
  // survives a hard kill (closed laptop lid, OS force-quit, power loss)
  // that arrives before the next debounced save. Without this, the
  // renderer holds the sessionId in memory only and the user's
  // "continuous" conversation silently restarts from scratch on the
  // next launch.
  let didCaptureNewSessionId = false
  set((state) => {
    const statusFields = new Map(state.engineStatusFields)

    // Trace permission denials for diagnostics
    if (event.fields?.permissionDenials?.length) {
      console.log(`[engine_status] key=${key} tabId=${tabId} denials=${JSON.stringify(event.fields.permissionDenials.map((d: { toolName: string }) => d.toolName))} state=${event.fields?.state}`)
    }

    // Merge last-known context/cost into incoming status fields so the
    // footer doesn't reset to 0% when the engine emits a status event
    // without usage data.
    const prev = state.engineStatusFields.get(key)
    const merged = { ...event.fields }
    if (!merged.contextPercent) {
      const usage = state.engineUsage.get(key)
      if (usage && usage.percent > 0) {
        merged.contextPercent = usage.percent
      }
    }
    if (!merged.totalCostUsd && prev?.totalCostUsd) {
      merged.totalCostUsd = prev.totalCostUsd
    }
    if (!merged.sessionId && prev?.sessionId) {
      merged.sessionId = prev.sessionId
    }
    statusFields.set(key, merged)

    // Capture model from engine status into the persistent model
    // override map so it survives desktop restarts. The engine is
    // authoritative about which model the conversation is actually
    // using; this back-populates engineModelOverrides from the
    // engine's live state. Without this, a desktop restart between
    // sessions would lose the model and fall back to the hardcoded
    // sonnet default.
    //
    // Guard: reject known-invalid values like "unknown" (which can
    // enter the system from stale state or an engine that hasn't
    // resolved its model yet) to prevent a feedback loop where the
    // desktop captures "unknown" and re-sends it on every prompt.
    let engineModelOverridesUpdate = state.engineModelOverrides
    const incomingModel = event.fields?.model
    const isValidModel = incomingModel && incomingModel.length > 0 && incomingModel !== 'unknown'
    if (isValidModel) {
      const currentOverride = state.engineModelOverrides.get(key)
      if (currentOverride !== incomingModel) {
        engineModelOverridesUpdate = new Map(state.engineModelOverrides)
        engineModelOverridesUpdate.set(key, incomingModel)
        console.log(`[engine_status] engineModelOverrides.set key=${key} model=${incomingModel} (was ${currentOverride || 'unset'})`)
      }
    }

    const sessionId = event.fields?.sessionId
    const pane = state.enginePanes.get(tabId)
    const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
    const isIdle = event.fields?.state === 'idle'
    const isRunning = event.fields?.state === 'running'
    let engineConversationIds = state.engineConversationIds
    if (sessionId) {
      const existing = state.engineConversationIds.get(key) ?? []
      if (existing[existing.length - 1] !== sessionId) {
        engineConversationIds = new Map(state.engineConversationIds)
        engineConversationIds.set(key, [...existing, sessionId])
        didCaptureNewSessionId = true
        // Permanent diagnostic log per the repo logging policy
        // (~/.claude/docs/standards/logging.md, repo CLAUDE.md
        // "Logging policy"). This is the only place the runtime
        // `engineConversationIds` map is mutated for engine-view tabs
        // (compound `${tabId}:${instanceId}` keys); without this line,
        // we have no way to confirm from logs alone that the source
        // map is being populated before the persistence layer reads
        // from it. Logs the exact key shape so a future "session not
        // resumed on restart" investigation can confirm the key
        // matches what session-store-persistence.ts expects.
        console.log(`[engine_status] engineConversationIds.set key=${key} sessionId=${sessionId} chainLen=${existing.length + 1}`)
      }
    }

    // Promote AskUserQuestion / ExitPlanMode permissionDenials carried
    // on engine_status into the per-engine-instance
    // `enginePermissionDenied` map (keyed by the compound
    // `${tabId}:${instanceId}` key). This is the engine-view
    // counterpart to the sessionPlane synthesis at
    // engine-control-plane-events.ts:handleStatusEvent — which is
    // bypassed for engine-view tabs because EngineControlPlane is
    // keyed by bare tabId and engine-view events arrive with the
    // compound key.
    //
    // Per-instance scoping (vs. mutating the parent
    // `tab.permissionDenied`) is what keeps sibling instances under
    // the same engine tab from showing each other's cards when the
    // user switches between sub-tabs. The parent tab's pill still
    // glows via getWaitingState() in TabStripShared.ts, which folds
    // across this map for engine tabs.
    //
    // Snapshot/idempotence rules:
    //   - We write `state.enginePermissionDenied.set(key, ...)` using
    //     the FULL compound key — not the parent tabId.
    //   - When the array is empty/absent (a follow-up cost-only
    //     `engine_status` tick), we PRESERVE any existing entry for
    //     this key so the card stays visible. The renderer-side card
    //     render in EngineView relies on this — the engine emits one
    //     engine_status with denials and then a stream of cost-only
    //     ticks; clobbering would make the card flicker out.
    //   - We log both branches with verbosity matching event-slice.ts's
    //     `[task_complete] tab=... branch=...` lines so a single grep
    //     covers CLI + engine paths. `enginePermDenied` is the
    //     engine-tab marker; CLI tabs use the older `permDenied` token
    //     in their own logs.
    const askOrExitDenials: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> = (event.fields?.permissionDenials || []).filter(
      (d: { toolName: string }) => d.toolName === 'AskUserQuestion' || d.toolName === 'ExitPlanMode',
    )
    const hasInterestingDenials = askOrExitDenials.length > 0
    let enginePermissionDeniedUpdate: Map<string, { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null> | null = null
    if (hasInterestingDenials) {
      const toolNamesStr = JSON.stringify(askOrExitDenials.map((d) => d.toolName))
      const instanceId = key.split(':')[1] || ''
      console.log(`[engine_status] tab=${tabId.slice(0, 8)} instance=${instanceId} branch=denials enginePermDenied set to ${toolNamesStr}`)
      enginePermissionDeniedUpdate = new Map(state.enginePermissionDenied)
      enginePermissionDeniedUpdate.set(key, { tools: askOrExitDenials })
    } else if ((event.fields?.permissionDenials?.length ?? 0) === 0) {
      // Cost-only or running tick — PRESERVE existing entry for this
      // key. Logged at debug verbosity (no state change). Keep the
      // noise low; only log if we currently hold a card to preserve
      // for this instance.
      const existing = state.enginePermissionDenied.get(key)
      if (existing?.tools?.length) {
        const instanceId = key.split(':')[1] || ''
        console.log(`[engine_status] tab=${tabId.slice(0, 8)} instance=${instanceId} branch=noDenials preserving existing enginePermDenied (${existing.tools.length} tools)`)
      }
    }

    const needsTabUpdate = isActive && (sessionId || isIdle || isRunning)
    // Fold conversationId / status updates into the same tabs.map pass
    // when applicable. The `enginePermissionDenied` map is returned
    // separately — it lives outside the per-tab struct.
    const returnPatch: Partial<typeof state> = { engineStatusFields: statusFields, engineConversationIds, engineModelOverrides: engineModelOverridesUpdate }
    if (enginePermissionDeniedUpdate) {
      returnPatch.enginePermissionDenied = enginePermissionDeniedUpdate
    }
    if (needsTabUpdate) {
      const tabs = state.tabs.map((t) => {
        if (t.id !== tabId) return t
        const updates: Partial<typeof t> = {}
        if (sessionId && t.conversationId !== sessionId) {
          updates.conversationId = sessionId
          updates.lastKnownSessionId = sessionId
        }
        if (isRunning && t.status !== 'running' && isActive) {
          updates.status = 'running' as const
        }
        if (isIdle && t.status !== 'idle' && isActive) {
          // When the engine reports AskUserQuestion / ExitPlanMode
          // denials, set status='completed' so the tab strip shows the
          // "waiting" pill. The actual denial data lives in
          // enginePermissionDenied (per-instance, set above) — we do
          // NOT mutate tab.permissionDenied here because that field is
          // CLI-only. Engine tabs use the per-instance map.
          if (hasInterestingDenials) {
            updates.status = 'completed' as const
          } else if ((event.fields?.backgroundAgents ?? 0) > 0) {
            // Parent LLM is idle but background dispatch agents are
            // still running. Keep tab status as 'running' so the tab
            // pill stays active and the interrupt button remains visible.
            updates.status = 'running' as const
          } else {
            updates.status = 'idle' as const
          }
        }
        return Object.keys(updates).length > 0 ? { ...t, ...updates } : t
      })
      returnPatch.tabs = tabs
    }
    return returnPatch
  })
  return { didCaptureNewSessionId }
}
