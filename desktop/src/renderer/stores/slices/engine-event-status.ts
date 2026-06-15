import type { StoreSet } from '../session-store-types'
import type { EngineEvent, ConversationPane, StatusFields } from '../../../shared/types'
import { parseSessionKey } from '../../../shared/session-key'

/**
 * Return a new conversationPanes Map with the given instance fields patched for
 * the instance identified by `key` (`${tabId}:${instanceId}`). No-ops
 * silently when the pane or instance is not found.
 */
export function withInstancePatch(
  conversationPanes: Map<string, ConversationPane>,
  key: string,
  patch: Partial<{
    statusFields: StatusFields | null
    conversationIds: string[]
    permissionDenied: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null
    modelOverride: string | null
  }>,
): Map<string, ConversationPane> {
  const { tabId, instanceId } = parseSessionKey(key)
  const pane = conversationPanes.get(tabId)
  if (!pane) return conversationPanes
  const idx = pane.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return conversationPanes
  const updated = new Map(conversationPanes)
  const instances = pane.instances.slice()
  instances[idx] = { ...instances[idx], ...patch }
  updated.set(tabId, { ...pane, instances })
  return updated
}

/**
 * Handler for `engine_status` events on engine-view tabs (compound
 * `${tabId}:${instanceId}` key). Extracted from engine-event-slice.ts
 * to keep that file under the 600-line TypeScript cap.
 *
 * Behavior:
 *   - Captures new sessionIds into instance.conversationIds and signals
 *     the caller (via the returned `didCaptureNewSessionId` flag) so it
 *     can trigger an immediate persistence flush — this is what makes
 *     the conversation chain survive a hard kill.
 *   - Promotes AskUserQuestion / ExitPlanMode permissionDenials into
 *     instance.permissionDenied, preserving prior entries on cost-only
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
  // instance.conversationIds — if so, the caller triggers an immediate
  // persistence flush after the reducer returns so the sessionId
  // survives a hard kill (closed laptop lid, OS force-quit, power loss)
  // that arrives before the next debounced save. Without this, the
  // renderer holds the sessionId in memory only and the user's
  // "continuous" conversation silently restarts from scratch on the
  // next launch.
  let didCaptureNewSessionId = false
  set((state) => {
    // Trace permission denials for diagnostics
    if (event.fields?.permissionDenials?.length) {
      console.log(`[engine_status] key=${key} tabId=${tabId} denials=${JSON.stringify(event.fields.permissionDenials.map((d: { toolName: string }) => d.toolName))} state=${event.fields?.state}`)
    }

    // Merge last-known context/cost into incoming status fields so the
    // footer doesn't reset to 0% when the engine emits a status event
    // without usage data.
    const { instanceId } = parseSessionKey(key)
    const pane = state.conversationPanes.get(tabId)
    const existingInst = pane?.instances.find((i) => i.id === instanceId)
    const prev = existingInst?.statusFields ?? null
    const merged: StatusFields = { ...event.fields }
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

    // Capture model from engine status into the instance modelOverride
    // so it survives desktop restarts. The engine is authoritative about
    // which model the conversation is actually using. Without this, a
    // desktop restart between sessions would lose the model and fall back
    // to the hardcoded sonnet default.
    //
    // Guard: reject known-invalid values like "unknown" (which can
    // enter the system from stale state or an engine that hasn't
    // resolved its model yet) to prevent a feedback loop where the
    // desktop captures "unknown" and re-sends it on every prompt.
    const incomingModel = event.fields?.model
    const isValidModel = incomingModel && incomingModel.length > 0 && incomingModel !== 'unknown'
    if (isValidModel && existingInst) {
      const currentOverride = existingInst.modelOverride
      if (currentOverride !== incomingModel) {
        console.log(`[engine_status] modelOverride.set key=${key} model=${incomingModel} (was ${currentOverride || 'unset'})`)
      }
    }

    const sessionId = event.fields?.sessionId
    const isActive = !pane || pane.activeInstanceId === instanceId
    const isIdle = event.fields?.state === 'idle'
    const isRunning = event.fields?.state === 'running'
    let newConversationIds: string[] | null = null
    if (sessionId) {
      const existing = existingInst?.conversationIds ?? []
      if (existing[existing.length - 1] !== sessionId) {
        newConversationIds = [...existing, sessionId]
        didCaptureNewSessionId = true
        // Permanent diagnostic log per the repo logging policy.
        // This is the only place the runtime conversationIds list is
        // mutated for engine-view instances; without this line, we have
        // no way to confirm from logs alone that it's being populated
        // before the persistence layer reads it. Logs the exact key
        // shape so a future "session not resumed on restart" investigation
        // can confirm the key matches what session-store-persistence.ts expects.
        console.log(`[engine_status] conversationIds.set key=${key} sessionId=${sessionId} chainLen=${newConversationIds.length}`)
      }
    }

    // Promote AskUserQuestion / ExitPlanMode permissionDenials carried
    // on engine_status into instance.permissionDenied. This is the
    // engine-view counterpart to the sessionPlane synthesis at
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
    // across instances for engine tabs.
    //
    // Snapshot/idempotence rules:
    //   - When the array is empty/absent (a follow-up cost-only
    //     `engine_status` tick), we PRESERVE any existing entry for
    //     this instance so the card stays visible. The renderer-side
    //     card render in EngineView relies on this — the engine emits
    //     one engine_status with denials and then a stream of cost-only
    //     ticks; clobbering would make the card flicker out.
    const askOrExitDenials: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> = (event.fields?.permissionDenials || []).filter(
      (d: { toolName: string }) => d.toolName === 'AskUserQuestion' || d.toolName === 'ExitPlanMode',
    )
    const hasInterestingDenials = askOrExitDenials.length > 0
    let newPermissionDenied: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null = null
    if (hasInterestingDenials) {
      const toolNamesStr = JSON.stringify(askOrExitDenials.map((d) => d.toolName))
      console.log(`[engine_status] tab=${tabId.slice(0, 8)} instance=${instanceId} branch=denials permissionDenied set to ${toolNamesStr}`)
      newPermissionDenied = { tools: askOrExitDenials }
    } else if ((event.fields?.permissionDenials?.length ?? 0) === 0) {
      // Cost-only or running tick — PRESERVE existing entry for this
      // instance. Logged at debug verbosity (no state change).
      const existing = existingInst?.permissionDenied
      if (existing?.tools?.length) {
        console.log(`[engine_status] tab=${tabId.slice(0, 8)} instance=${instanceId} branch=noDenials preserving existing permissionDenied (${existing.tools.length} tools)`)
      }
    }

    const returnPatch: Partial<typeof state> = {}

    // Auto-clear the model-fallback indicator on the idle transition.
    // The fallback indicator is a workflow signal — once the affected
    // run completes (state=idle), the user has seen the ⚠ glyph and
    // the next dispatch starts fresh. No wall-clock timer: per
    // docs/architecture/agent-state.md, clients do not invent retention
    // rules. If the run never completes, the indicator stays sticky.
    //
    // Defensive: pre-existing test harnesses don't always initialize
    // engineModelFallbacks on their mock state object. Production
    // initializes it in sessionStore.ts, but the guard keeps this
    // helper compatible with leaner test scaffolding.
    if (isIdle && state.engineModelFallbacks?.has(key)) {
      const fallbacks = new Map(state.engineModelFallbacks)
      fallbacks.delete(key)
      returnPatch.engineModelFallbacks = fallbacks
    }

    const needsTabUpdate = isActive && (sessionId || isIdle || isRunning)
    if (needsTabUpdate) {
      const tabs = state.tabs.map((t) => {
        if (t.id !== tabId) return t
        const updates: Partial<typeof t> = {}
        if (sessionId && t.conversationId !== sessionId) {
          updates.conversationId = sessionId
          updates.lastKnownSessionId = sessionId
        }
        // Project the engine-reported context window onto the parent tab
        // so the local-percent recomputation in StatusBarContextIndicator
        // has the engine's truth to divide by. Without this, the indicator
        // falls back to the picker-selected model's nominal window, which
        // produces a 100% reading whenever the picker disagrees with the
        // engine (e.g. opus-running conversation displayed under a Sonnet
        // picker selection).
        const incomingWindow = event.fields?.contextWindow
        if (typeof incomingWindow === 'number' && incomingWindow > 0 && t.contextWindow !== incomingWindow) {
          updates.contextWindow = incomingWindow
        }
        if (isRunning && t.status !== 'running' && isActive) {
          updates.status = 'running' as const
        }
        if (isIdle && t.status !== 'idle' && isActive) {
          // When the engine reports AskUserQuestion / ExitPlanMode
          // denials, set status='completed' so the tab strip shows the
          // "waiting" pill. The actual denial data lives in
          // instance.permissionDenied (per-instance, set above) — we do
          // NOT mutate tab.permissionDenied here because that field is
          // CLI-only. Engine tabs use the per-instance field.
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

    // Update ConversationInstance fields on the instance in conversationPanes.
    const instancePatch: Parameters<typeof withInstancePatch>[2] = {
      statusFields: merged,
    }
    if (newConversationIds !== null) {
      instancePatch.conversationIds = newConversationIds
    }
    if (newPermissionDenied !== null) {
      instancePatch.permissionDenied = newPermissionDenied
    }
    if (isValidModel && incomingModel) {
      instancePatch.modelOverride = incomingModel
    }
    const updatedPanes = withInstancePatch(state.conversationPanes, key, instancePatch)
    if (updatedPanes !== state.conversationPanes) {
      returnPatch.conversationPanes = updatedPanes
    }

    return returnPatch
  })
  return { didCaptureNewSessionId }
}
