// @file-size-exception: single translation layer EngineEvent→NormalizedEvent
// covering every engine_* wire type. Splitting by event category would produce
// 5-10 files that cannot be tested independently (they share the switch arms
// and the TabEntry/EventEmitterContext closure). Consolidation is the lesser evil.
import type { EngineBridge } from './engine-bridge'
import type { EngineEvent, NormalizedEvent, TabStatus, EnrichedError, EngineConfig } from '../shared/types'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'
import { handleExportEvent } from './engine-export-handler'
import { conversationExists } from './session-meta'

const TAG = 'SessionPlane'
function log(msg: string): void { _log(TAG, msg) }
function debug(msg: string): void { _debug(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

export interface TabEntry {
  tabId: string
  status: TabStatus
  activeRequestId: string | null
  conversationId: string | null
  engineSessionStarted: boolean
  lastActivityAt: number
  promptCount: number
  /**
   * Number of prompts submitted since the last freshness checkpoint.
   *
   * A "checkpoint" is any event that semantically restores the tab to
   * "fresh blank session" status for the purpose of the slash-command
   * plan→auto auto-switch guard (`isFirstPromptForTab` in slash-classify.ts).
   * Two events advance this checkpoint:
   *
   *   1. `resetTabSession` — full session reset (stops the engine session,
   *      drops the conversation id). Zeros `promptCount` too.
   *   2. `notifyConversationCleared` — `/clear` succeeded. The engine
   *      session and conversation id intentionally stay alive (it's a
   *      checkpoint, not a session restart), but the LLM-visible history
   *      has been wiped, so the next slash command should be treated as
   *      the first prompt of a blank conversation. `promptCount` is
   *      preserved in that case because it remains a useful "total prompts
   *      this app boot" counter for logging.
   *
   * Why a separate field rather than reusing `promptCount`: callers of
   * `getTabStatus` may still want the total prompt count (e.g. logging),
   * so we keep both. The guard consults this checkpoint-relative counter
   * exclusively.
   */
  promptCountSinceCheckpoint: number
  /**
   * Set `true` by `notifyConversationCleared`, cleared by `submitPrompt`.
   *
   * This flag disambiguates two states that look identical to the
   * `promptCountSinceCheckpoint` counter alone:
   *
   *   A. Tab just cleared (`/clear` fired) — `promptCountSinceCheckpoint`
   *      is 0, but the renderer still sends its stale `conversationId` as
   *      `runOptions.sessionId`. The guard should treat this as fresh.
   *   B. Tab restored from disk (app restart) — `promptCountSinceCheckpoint`
   *      is 0, and the renderer sends the restored `conversationId` as
   *      `runOptions.sessionId`. The guard should treat this as resumed.
   *
   * Without this flag the guard cannot tell A from B — both have
   * `promptCountSinceCheckpoint === 0` and `runOptionsSessionId` set.
   * With the flag: A has `clearedSinceLastPrompt === true`, so the guard
   * returns "fresh" and the plan→auto switch fires. B has the flag
   * `false` (never set after a restore), so the guard returns "not fresh".
   */
  clearedSinceLastPrompt: boolean
  /**
   * Set `true` only when the tab's tracked `conversationId` came from
   * RESUMING A SAVED conversation — a caller-supplied id on restore
   * (`seedConversationId`, or `ensureSession` with `opts.conversationId`
   * provided). Left `false` when the engine MINTED a fresh id at eager
   * start for a brand-new session (the `ensureSession` capture of
   * `result.conversationId` when the tab had no prior/supplied id).
   *
   * This disambiguates a THIRD scenario that `clearedSinceLastPrompt` and
   * the bare presence of `runOptions.sessionId` cannot tell apart from a
   * restored conversation (scenario B above):
   *
   *   C. Brand-new session that eagerly started — `promptCountSinceCheckpoint`
   *      is 0, no conversation file exists on disk yet, but the engine
   *      pre-minted a `conversationId` that `ensureSession` captured onto
   *      `tab.conversationId`. The renderer then sends that minted id as
   *      `runOptions.sessionId`, so to the freshness guard it looks
   *      IDENTICAL to scenario B (count 0 + sessionId set) — yet it is
   *      genuinely fresh. The `isFirstPromptForTab` guard must treat C as
   *      fresh (so a first-prompt slash command flips plan→auto) while
   *      still treating B as resumed.
   *
   * The guard therefore keys "resumed ⇒ not fresh" off THIS flag, not off
   * the mere presence of `runOptionsSessionId` (which is set in both B and
   * C). B sets this flag `true` (caller supplied the saved id); C leaves it
   * `false` (engine minted the id).
   */
  resumedSavedConversation: boolean
  permissionMode: 'auto' | 'plan'
  approvedTools: string[]
  startedAt: number
  toolCallCount: number
  sawPermissionRequest: boolean
  /**
   * Signature of the proposal denial (ExitPlanMode / AskUserQuestion) most
   * recently surfaced to the renderer via a synthesized task_complete.
   *
   * The engine RE-PUBLISHES its retained `lastPermissionDenials` on every
   * heartbeat idle (engine `manager_heartbeat.go`) so a reattaching consumer
   * sees the pending proposal. A settled ('completed' / 'idle') tab therefore
   * receives the SAME ExitPlanMode denial on every cost-only heartbeat tick.
   *
   * Without dedup, exempting proposal-bearing idles from the duplicate-skip
   * guard (so the first proposal is never dropped — Bug #2) would re-synthesize
   * a task_complete on every heartbeat and could resurrect a card the user
   * already dismissed. This signature records what was last surfaced so the
   * proposal pass-through fires ONCE per distinct proposal: the first delivery
   * surfaces it; identical heartbeat echoes are skipped; a genuinely new
   * proposal (different tool / plan path / run) re-fires.
   *
   * Reset to null on a real run start (state='running') and on session
   * reset/clear, so the next proposal after new work always re-surfaces.
   */
  lastSurfacedProposalSig: string | null
}

export interface EventEmitterContext {
  bridge: EngineBridge
  emit: (eventName: string, ...args: unknown[]) => void
  setStatus: (tabId: string, newStatus: TabStatus) => void
  checkDrain: () => void
}

export function handleEngineEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: EngineEvent,
): void {
  tab.lastActivityAt = Date.now()
  debug(`event: tabId=${tabId} type=${event.type}`)

  switch (event.type) {
    case 'engine_text_delta':
      ctx.emit('event', tabId, { type: 'text_chunk', text: event.text } as NormalizedEvent)
      break

    case 'engine_tool_start':
      tab.toolCallCount++
      log(`tool_start: tabId=${tabId} tool=${event.toolName} toolId=${event.toolId} count=${tab.toolCallCount}`)
      ctx.emit('event', tabId, {
        type: 'tool_call',
        toolName: event.toolName,
        toolId: event.toolId,
        index: tab.toolCallCount - 1,
      } as NormalizedEvent)
      break

    case 'engine_tool_update':
      ctx.emit('event', tabId, {
        type: 'tool_call_update',
        toolId: event.toolId,
        partialInput: event.partialInput,
      } as NormalizedEvent)
      break

    case 'engine_tool_complete':
      ctx.emit('event', tabId, {
        type: 'tool_call_complete',
        index: event.index,
      } as NormalizedEvent)
      break

    case 'engine_tool_end':
      debug(`tool_end: tabId=${tabId} toolId=${event.toolId} isError=${event.isError}`)
      ctx.emit('event', tabId, {
        type: 'tool_result',
        toolId: event.toolId,
        content: event.result || '',
        isError: event.isError || false,
      } as NormalizedEvent)
      break

    case 'engine_message_end':
      // End of one LLM message within a multi-turn run. Carries per-message
      // token usage (for the context bar) and seals the current assistant row
      // (prevents the next text_chunk from appending to it).
      if (event.usage) {
        log(`message_end: tabId=${tabId} in=${event.usage.inputTokens} out=${event.usage.outputTokens} cost=$${event.usage.cost ?? 0}`)
        // Keep the legacy usage event for the context bar (contextTokens on tab).
        ctx.emit('event', tabId, {
          type: 'usage',
          usage: {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
          },
        } as NormalizedEvent)
      }
      // Emit message_end to seal the current assistant row in the single reducer.
      ctx.emit('event', tabId, {
        type: 'message_end',
        inputTokens: event.usage?.inputTokens,
        outputTokens: event.usage?.outputTokens,
        contextPercent: event.usage?.contextPercent,
        cost: event.usage?.cost,
      } as NormalizedEvent)
      break

    case 'engine_status':
      handleStatusEvent(ctx, tabId, tab, event)
      break

    case 'engine_error':
      error(`engine_error: tabId=${tabId} msg=${event.message}`)
      ctx.emit('event', tabId, {
        type: 'error',
        message: event.message,
        isError: true,
      } as NormalizedEvent)
      break

    case 'engine_dead':
      handleDeadEvent(ctx, tabId, tab, event)
      break

    case 'engine_permission_request':
      log(`permission_request: tabId=${tabId} tool=${event.permToolName}`)
      tab.sawPermissionRequest = true
      ctx.emit('event', tabId, {
        type: 'permission_request',
        questionId: event.questionId,
        toolName: event.permToolName,
        toolDescription: event.permToolDescription,
        toolInput: event.permToolInput,
        options: event.permOptions,
      } as NormalizedEvent)
      ctx.emit('remote-permission', tabId, {
        questionId: event.questionId,
        toolName: event.permToolName,
        toolInput: event.permToolInput,
        options: event.permOptions,
      })
      break

    case 'engine_working_message':
      // Extension harness live-status string. Emit as normalized working_message
      // so event-slice.ts updates engineWorkingMessages keyed by bare tabId.
      ctx.emit('event', tabId, {
        type: 'working_message',
        message: event.message || '',
      } as NormalizedEvent)
      break

    case 'engine_notify':
      // Extension harness ephemeral notification. Emit as normalized notify
      // so event-slice.ts pushes to engineNotifications keyed by bare tabId.
      // For error-level notifications also emit an `error` NormalizedEvent so
      // the conversation stream shows the error message.
      if (event.level === 'error') {
        ctx.emit('event', tabId, {
          type: 'error',
          message: event.message || '',
          isError: true,
        } as NormalizedEvent)
      }
      ctx.emit('event', tabId, {
        type: 'notify',
        message: event.message || '',
        level: event.level || 'info',
      } as NormalizedEvent)
      break

    case 'engine_dialog':
      // Extension harness modal prompt. Emit as normalized dialog so
      // event-slice.ts updates engineDialogs keyed by bare tabId.
      ctx.emit('event', tabId, {
        type: 'dialog',
        dialogId: event.dialogId || '',
        method: event.method || '',
        title: event.title || '',
        options: event.options,
        defaultValue: event.defaultValue,
      } as NormalizedEvent)
      break

    case 'engine_elicitation_request':
      // An extension called ctx.elicit(). The engine fans this to every
      // connected client and blocks (indefinite human-wait) until one
      // answers with an `elicitation_response` command. Translate to a
      // normalized elicitation_request so event-slice.ts pushes it onto the
      // active instance's elicitationQueue and the renderer can show an
      // approval card. Without this case the event is dropped and the run
      // parks forever (the dev-lead dispatch stall this fix targets).
      log(
        `elicitation_request: tabId=${tabId} requestId=${event.requestId} mode=${event.elicitMode ?? ''}`,
      )
      ctx.emit('event', tabId, {
        type: 'elicitation_request',
        requestId: event.requestId || '',
        mode: event.elicitMode || '',
        schema: event.schema,
        url: event.url,
      } as NormalizedEvent)
      break

    case 'engine_plan_mode_changed':
      log(`plan_mode_changed: tabId=${tabId} enabled=${event.planModeEnabled}`)
      // Only Enabled:true is authoritative — model-initiated EnterPlanMode
      // confirms the session has entered plan mode and the snapshot must
      // reflect that. Enabled:false is intentionally NOT synced here: the
      // engine no longer emits it for ExitPlanMode (model proposal only),
      // and the user-approval gate in the renderer's onImplement handler
      // is the single chokepoint for the mode flip back to 'auto'. If a
      // false event ever arrives (e.g. from a future engine path) we still
      // forward it to the renderer but do not mutate permissionMode here.
      if (event.planModeEnabled) {
        if (tab.permissionMode !== 'plan') {
          tab.permissionMode = 'plan'
          log(`plan_mode_changed: tabId=${tabId} engine flipped to plan, syncing tab.permissionMode`)
        }
      } else {
        log(`plan_mode_changed: tabId=${tabId} enabled=false ignored (mode flip deferred to user-approval chokepoint)`)
      }
      ctx.emit('event', tabId, event as any)
      break

    case 'engine_plan_file_written':
      // A Write/Edit landed on the canonical plan file. This is the accurate
      // trigger for the "plan created / updated" conversation marker — the
      // file now exists with content, so the marker is correctly positioned
      // and any link resolves. Forward to the renderer reducer, which inserts
      // the divider (event-slice-plan-mode.ts). Distinct from
      // engine_plan_mode_changed, which only flips plan-mode state.
      log(
        `plan_file_written: tabId=${tabId} op=${event.planWriteOperation} planFilePath=${event.planFilePath ?? ''} planSlug=${event.planSlug ?? ''}`,
      )
      ctx.emit('event', tabId, event as any)
      break

    case 'engine_plan_mode_auto_exit':
      // Engine synthesized an ExitPlanMode at end-of-turn. Emit as a
      // NormalizedEvent so the single reducer (event-slice.ts) can clear
      // the active instance's permissionMode. The parent tab.permissionMode
      // is NOT written here — the sticky-parent invariant requires that only
      // the active instance carries plan mode for extension-hosted tabs.
      log(`plan_mode_auto_exit: tabId=${tabId} stopReason=${event.stopReason}`)
      ctx.emit('event', tabId, {
        type: 'plan_mode_auto_exit',
        stopReason: event.stopReason || '',
        planFilePath: event.planFilePath,
        planSlug: event.planSlug,
        reason: event.reason,
        sessionId: event.sessionId,
        runId: event.runId,
      } as NormalizedEvent)
      break

    case 'engine_plan_proposal':
      // The model has proposed a plan-mode transition (currently only
      // kind="exit" — the model called ExitPlanMode). This is a workflow
      // event, NOT a state transition: the actual mode change is deferred
      // to the user-approval chokepoint in usePermissionDeniedHandlers.
      // The desktop forwards the event to the renderer as the authoritative
      // signal that an approval card should render; the permission_denial
      // path on engine_status remains the fallback card-render trigger so
      // existing logic keeps working during the migration. See
      // docs/architecture/adr/003-state-events-vs-workflow-events.md.
      log(
        `plan_proposal: tabId=${tabId} kind=${event.planProposalKind} planFilePath=${event.planFilePath ?? ''} planSlug=${event.planSlug ?? ''}`,
      )
      ctx.emit('event', tabId, event as any)
      break

    case 'engine_stream_reset':
      log(`stream_reset: tabId=${tabId} (retry in progress, discarding partial text)`)
      ctx.emit('event', tabId, { type: 'stream_reset' } as NormalizedEvent)
      break

    case 'engine_compacting':
      log(`compacting: tabId=${tabId} active=${event.active}`)
      ctx.emit('event', tabId, { type: 'compacting', active: event.active } as NormalizedEvent)
      break

    case 'engine_tool_stalled':
      debug(`tool_stalled: tabId=${tabId} tool=${event.toolName} elapsed=${event.toolElapsed}s`)
      ctx.emit('event', tabId, {
        type: 'tool_stalled',
        toolId: event.toolId,
        toolName: event.toolName,
        elapsed: event.toolElapsed,
      } as NormalizedEvent)
      break

    case 'engine_run_stalled':
      // Advisory watchdog signal. The legacy path only logged this; emit as
      // normalized run_stalled so the renderer can surface a distinct indicator.
      debug(`run_stalled: tabId=${tabId} duration=${event.runStalledDuration} lastActivity=${event.runStalledLastActivity ?? 'unknown'}`)
      ctx.emit('event', tabId, {
        type: 'run_stalled',
        stalledDuration: event.runStalledDuration,
        lastActivity: event.runStalledLastActivity,
      } as NormalizedEvent)
      break

    case 'engine_steer_injected':
      // Mid-turn steer-drain confirmation. The runloop captures a steer
      // message between turns, inside the end_turn checkpoint, or after
      // tool execution; this event tells consumers the steer landed in
      // the conversation as a user turn before the next LLM call.
      log(`steer_injected: tabId=${tabId} messageLength=${event.steerMessageLength}`)
      ctx.emit('event', tabId, {
        type: 'steer_injected',
        messageLength: event.steerMessageLength,
      } as NormalizedEvent)
      break

    case 'engine_thinking_block_start':
      // Extended thinking (issue #158), plain-conversation path. The model
      // began a reasoning block. Translate to the normalized-stream
      // `thinking_block_start` so event-slice.ts opens a `role: 'thinking'`
      // row. Boundaries always arrive when reasoning happened; the per-token
      // delta may be suppressed engine-side (summary-only path). Mirrors the
      // extension-hosted path in engine-event-slice.ts.
      log(`thinking_block_start: tabId=${tabId}`)
      ctx.emit('event', tabId, { type: 'thinking_block_start' } as NormalizedEvent)
      break

    case 'engine_thinking_delta':
      // Incremental reasoning text — peer of engine_text_delta for the
      // thinking channel. Only arrives when the engine's ThinkingConfig
      // .StreamDeltas is on (boundaries always flow regardless). Translate to
      // the normalized `thinking_delta` so the renderer appends it to the open
      // thinking row.
      log(`thinking_delta: tabId=${tabId} len=${event.thinkingText?.length ?? 0}`)
      ctx.emit('event', tabId, {
        type: 'thinking_delta',
        text: event.thinkingText,
      } as NormalizedEvent)
      break

    case 'engine_thinking_block_end':
      // The reasoning block finished. Carries a summary (elapsed seconds,
      // token estimate, redacted flag) so the renderer can show "💭 Thought
      // for Ns" even when deltas were suppressed. Translate to the normalized
      // `thinking_block_end` so event-slice.ts seals the active thinking row.
      log(
        `thinking_block_end: tabId=${tabId} elapsed=${event.thinkingElapsedSeconds ?? '?'}s ` +
        `tokens=${event.thinkingTotalTokens ?? '?'} redacted=${!!event.thinkingRedacted}`,
      )
      ctx.emit('event', tabId, {
        type: 'thinking_block_end',
        totalTokens: event.thinkingTotalTokens,
        elapsedSeconds: event.thinkingElapsedSeconds,
        redacted: event.thinkingRedacted,
      } as NormalizedEvent)
      break

    case 'engine_agent_state':
      // Emit as normalized agent_state so the single reducer can update
      // the active instance's agentStates in event-slice.ts. Previously
      // only engine-event-slice.ts handled this via the raw stream.
      ctx.emit('event', tabId, {
        type: 'agent_state',
        agents: event.agents || [],
      } as NormalizedEvent)
      break

    case 'engine_harness_message':
      // Extension harness display message (e.g. welcome banner). Emit as
      // normalized harness_message so event-slice.ts can apply dedup logic
      // and append to the active instance's messages.
      ctx.emit('event', tabId, {
        type: 'harness_message',
        message: event.message || '',
        dedupKey: (event.metadata as any)?.dedupKey || undefined,
        source: event.source,
      } as NormalizedEvent)
      break

    case 'engine_extension_died':
      ctx.emit('event', tabId, {
        type: 'extension_died',
        extensionName: event.extensionName || '',
      } as NormalizedEvent)
      break

    case 'engine_extension_respawned':
      ctx.emit('event', tabId, {
        type: 'extension_respawned',
        extensionName: event.extensionName || '',
        attemptNumber: event.attemptNumber || 0,
      } as NormalizedEvent)
      break

    case 'engine_extension_dead_permanent':
      ctx.emit('event', tabId, {
        type: 'extension_dead_permanent',
        extensionName: event.extensionName || '',
        attemptNumber: event.attemptNumber || 0,
      } as NormalizedEvent)
      break

    case 'engine_events_dropped':
      ctx.emit('event', tabId, {
        type: 'events_dropped',
        count: event.count || 0,
      } as NormalizedEvent)
      break

    case 'engine_model_fallback':
      // Model fallback workflow signal. Emit as normalized model_fallback
      // so event-slice.ts can set the engineModelFallbacks indicator.
      ctx.emit('event', tabId, {
        type: 'model_fallback',
        requestedModel: event.fallbackRequestedModel || '',
        fallbackModel: event.fallbackModel || '',
        reason: event.fallbackReason || '',
      } as NormalizedEvent)
      break

    case 'engine_early_stop_decision_request':
      // The engine is asking whether to nudge the model to keep working.
      // Promote this to a Bridge-level event so the policy module
      // (early-stop-policy.ts, wired in engine-bridge.ts) can build a
      // response synchronously from the persisted setting. The engine
      // gives us 100ms to reply; the policy module must respond off the
      // event loop, not via any async I/O.
      log(
        `early_stop_decision_request: tabId=${tabId} requestId=${event.earlyStopRequestId} run=${event.earlyStopRunId} turn=${event.earlyStopTurnNumber} wouldContinue=${event.earlyStopWouldContinue}`,
      )
      ctx.emit('engine_early_stop_decision_request', tabId, event)
      break

    case 'engine_intercept':
      // Fire-and-forget signal: bubble up via ctx.emit so event-wiring.ts's
      // wireSessionPlaneEvents can call handleInterceptEvent without creating
      // a circular import through state.ts. The event carries the raw payload
      // and tabId; the wiring layer in event-wiring.ts does the routing.
      log(`intercept: tabId=${tabId} level=${event.interceptLevel} title=${event.interceptTitle}`)
      ctx.emit('engine_intercept', tabId, event)
      break

    case 'engine_export':
      // The engine has rendered a /export payload. Surface the save-as
      // dialog so the user can write it to disk. The engine_command_result
      // arrives next and is handled by the existing result-routing path.
      // exportFormat is the engine-resolved format (markdown/json/html/jsonl);
      // the handler maps it to a file extension without sniffing the payload.
      log(`export: tabId=${tabId} format=${event.exportFormat ?? 'absent'} payloadBytes=${event.message?.length ?? 0}`)
      // Fire-and-forget: the dialog is async but the engine event stream
      // continues without waiting. Errors are logged inside the handler.
      void handleExportEvent(event.message || '', event.exportFormat)
      break
  }
}

function handleStatusEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: Extract<EngineEvent, { type: 'engine_status' }>,
): void {
  if (!event.fields) return
  log(`engine_status: tabId=${tabId} state=${event.fields.state} sessionId=${event.fields.sessionId ?? 'none'} cost=$${event.fields.totalCostUsd ?? 0}`)
  // Forward the full StatusFields snapshot to the renderer BEFORE the
  // state-binding branches below. The renderer's `status` arm replaces
  // inst.statusFields wholesale (snapshot semantics). This is unconditional —
  // every engine_status, all states — so the renderer's statusFields tracks
  // model/backend/cost/extensionName on running, idle, and cost-only heartbeat
  // ticks alike, not just on idle (the binding/task_complete path below drops
  // those fields). The emit is additive; the existing binding logic is unchanged.
  log(`status: forwarding StatusFields snapshot to renderer tabId=${tabId} state=${event.fields.state} model=${event.fields.model ?? 'none'} backend=${event.fields.backend ?? 'api'}`)
  ctx.emit('event', tabId, { type: 'status', fields: event.fields } as NormalizedEvent)
  if (event.fields.state === 'idle') {
    if (event.fields.sessionId) {
      if (!tab.conversationId) {
        // First-ever bind: adopt the engine's id (normal first-start path).
        //
        // This branch is now reached ONLY when the tab genuinely had no id from
        // any source. The two start sites both seed tab.conversationId before
        // the engine can emit this idle: ensureSession seeds it from the tracked
        // id (plain tabs), and the ENGINE_START IPC calls
        // sessionPlane.seedConversationId from config.sessionId (extension
        // tabs). So a restored tab that knows its real conversation arrives here
        // already-seeded and takes the matching-id branch below — it never
        // adopts a pre-minted empty id. Reaching this branch means a true
        // first-start (new tab, no persisted conversation), where adopting the
        // engine's freshly-minted id is correct.
        log(`engine_status: tabId=${tabId} first-bind adopting engine sessionId=${event.fields.sessionId} (tab had no tracked id)`)
        tab.conversationId = event.fields.sessionId
        // True first-start (new tab, no persisted conversation) — a fresh mint,
        // not a resume. Leave resumedSavedConversation false (scenario C) so a
        // first-prompt slash command stays fresh and flips plan→auto.
        ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
      } else if (tab.conversationId === event.fields.sessionId) {
        // Matching id: no-op (normal heartbeat tick or stable idle).
        ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
      } else {
        // Divergence: the engine has a different id than the one this tab
        // tracks. There are two distinct sub-cases, and conflating them is what
        // caused the morning data loss:
        //
        //   (a) The tracked id is a REAL conversation (file exists on disk).
        //       This is the post-restart pre-mint footgun (#230 B1): the engine
        //       pre-minted before the client asserted the real id. Drive a
        //       resume so the engine rebinds the key to the real conversation.
        //
        //   (b) The tracked id is a PHANTOM (no backing file). It was itself a
        //       pre-mint from a PRIOR restart that was never saved. Driving a
        //       resume to it is futile — the engine now (correctly) ignores a
        //       fileless sessionId and pre-mints AGAIN, so re-pinning the
        //       phantom just spins the cascade that orphaned the real history.
        //       Instead, adopt the engine's freshly-minted id as the tab's new
        //       identity and stop fighting. The real prior history (if any) is
        //       in the persisted scrollback; a future save under this real id
        //       makes it durable. (#230/#231)
        const trackedIsReal = conversationExists(tab.conversationId)
        if (!trackedIsReal) {
          warn(
            `engine_status: tabId=${tabId} tracked conversationId=${tab.conversationId} has NO backing file (phantom) — adopting engine sessionId=${event.fields.sessionId} instead of re-driving a futile resume (breaks the empty-conversation cascade)`,
          )
          tab.conversationId = event.fields.sessionId
          ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
        } else {
          // (a) Real tracked conversation — drive the resume.
          //
          // Carry the tab's REAL config into the resume (workingDirectory,
          // extensions, model) rather than empty placeholders: a bare config would
          // start a degraded session (wrong cwd, no extensions). The bridge holds
          // the last EngineConfig used for this key; we reuse it and override only
          // sessionId so the engine resumes the original conversation with the same
          // working session. Falls back to a minimal config only if the bridge has
          // no record (should not happen for a started session). (#231)
          const priorConfig = ctx.bridge.getSessionConfig(tabId)
          const resumeConfig: EngineConfig = priorConfig
            ? { ...priorConfig, sessionId: tab.conversationId, forceNewConversation: false }
            : { profileId: 'default', extensions: [], workingDirectory: '', sessionId: tab.conversationId }
          warn(
            `engine_status: tabId=${tabId} engine sessionId=${event.fields.sessionId} diverges from tracked conversationId=${tab.conversationId} — driving resume to restore original conversation (dir=${resumeConfig.workingDirectory || 'none'} model=${resumeConfig.model ?? 'default'} extensions=${resumeConfig.extensions.length})`,
          )
          ctx.bridge.updateSessionConversationId(tabId, tab.conversationId)
          void ctx.bridge.startSession(tabId, resumeConfig)
        }
      }
    }

    // Session-ready idle: the engine emits engine_status(starting) → (idle)
    // when a session is first established, BEFORE any prompt runs (see
    // engine/internal/session/start_session.go). On the profile-launch create
    // path the renderer set its tab to 'connecting' (createConversationTab)
    // while the control-plane TabEntry is still 'idle'; this ready idle is the
    // only signal that clears the renderer's 'connecting'. A never-run session
    // is identified by activeRequestId == null && startedAt === 0 (no prompt
    // has ever been dispatched on this tab). Forward an 'idle' status
    // transition to the renderer — directly, because _setStatus would no-op
    // (the control-plane TabEntry is already 'idle') — and do NOT synthesize a
    // task_complete (that would fabricate a completed run and trip
    // auto-move-to-done for a session that ran nothing).
    const isReadyIdle = tab.activeRequestId == null && tab.startedAt === 0
    if (
      (tab.status === 'idle' || tab.status === 'connecting') &&
      isReadyIdle
    ) {
      log(`engine_status: session-ready idle for ${tab.status} tab ${tabId} — forwarding idle (no task_complete)`)
      ctx.emit('tab-status-change', tabId, 'idle', tab.status)
      ctx.checkDrain()
      return
    }

    // Compute whether THIS idle carries a proposal that needs a user
    // response (ExitPlanMode / AskUserQuestion) BEFORE the duplicate-skip
    // guard. A proposal-bearing idle is the first-and-only delivery of the
    // Plan Ready / question card trigger; it must never be silently dropped
    // as a "duplicate heartbeat". The guard below exists to suppress
    // cost-only heartbeat ticks and stale post-reset idles — NOT to drop the
    // first real proposal. (Bug #2: an auto-dispatched run that flips to plan
    // mid-run lands its ExitPlanMode denial on an idle that arrives while the
    // tab is already 'completed'/'idle' from a heartbeat, so the unconditional
    // skip dropped the only card trigger and the Plan Ready card never
    // rendered. Confirmed live in desktop.log: "skipping idle for idle tab
    // 60726597-…".)
    const idleNeedsUserResponse = event.fields.permissionDenials?.some(
      (d: any) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion',
    )

    // 'connecting' is exempted from the proposal pass-through below and ALWAYS
    // skips: a prompt has been dispatched (activeRequestId/startedAt set by
    // submitPrompt) and the engine hasn't replied state='running' yet, OR a
    // stale idle from a session killed by resetTabSession during the Implement
    // flow is arriving after the new run started. In BOTH 'connecting' cases a
    // newer run supersedes; the engine clears its lastPermissionDenials on the
    // new prompt dispatch (prompt_dispatch.go), so a denial echoed on a
    // 'connecting' idle is stale and must not resurrect a just-dismissed card.
    if (tab.status === 'connecting') {
      log(`engine_status: skipping idle for connecting tab ${tabId} (new run in flight — denials stale)`)
      return
    }

    if (
      (tab.status === 'completed' || tab.status === 'idle') &&
      !idleNeedsUserResponse
    ) {
      // 'completed' / 'idle' with NO proposal denial: already synthesized
      // task_complete for this idle transition — skip duplicates from
      // cost-only heartbeat ticks. The engine re-publishes retained denials
      // on every heartbeat (manager_heartbeat.go), so without this skip a
      // cost-only tick would synthesize a redundant task_complete.
      log(`engine_status: skipping idle for ${tab.status} tab ${tabId} (no proposal denials)`)
      return
    }

    if ((tab.status === 'completed' || tab.status === 'idle') && idleNeedsUserResponse) {
      // This idle carries a proposal denial (ExitPlanMode / AskUserQuestion)
      // and the tab is in a settled terminal state (NOT 'connecting', so no
      // newer run is in flight). It is the genuine card trigger for an
      // auto-dispatched mid-run plan flip — but the engine RE-PUBLISHES the
      // same retained denial on every heartbeat (manager_heartbeat.go), so we
      // must surface it ONCE per distinct proposal. Dedup on a stable
      // signature of the proposal so a heartbeat echo does not re-synthesize a
      // task_complete (which would resurrect a card the user already
      // dismissed). A genuinely new proposal (different tool / plan path)
      // produces a different signature and re-fires.
      const proposalSig = (event.fields.permissionDenials || [])
        .filter((d: any) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion')
        .map((d: any) => `${d.toolName}:${d.toolInput?.planFilePath ?? d.toolUseID ?? ''}`)
        .sort()
        .join('|')
      if (tab.lastSurfacedProposalSig === proposalSig) {
        log(`engine_status: skipping proposal idle for ${tab.status} tab ${tabId} (already surfaced sig=${proposalSig} — heartbeat echo, not resurrecting dismissed card)`)
        return
      }
      tab.lastSurfacedProposalSig = proposalSig
      // Log the first delivery so the decision is reconstructable from
      // desktop.log (logging policy: log both branches).
      const toolNames = (event.fields.permissionDenials || [])
        .map((d: any) => d.toolName)
        .join(',')
      log(`engine_status: forwarding proposal idle for ${tab.status} tab ${tabId} denials=[${toolNames}] sig=${proposalSig} (card trigger, first delivery)`)
    }

    const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
    ctx.emit('event', tabId, {
      type: 'task_complete',
      result: '',
      costUsd: event.fields.totalCostUsd || 0,
      durationMs,
      numTurns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      sessionId: tab.conversationId || '',
      permissionDenials: event.fields.permissionDenials,
    } as NormalizedEvent)

    tab.activeRequestId = null
    // Preserve 'completed' status whenever the engine reported denials that
    // require a user response. Otherwise a subsequent engine_status state=idle
    // (e.g. a cost-only update fired ~1ms later) will fail the guard at the
    // top of this branch (`tab.status === 'completed'`), synthesize a second
    // task_complete with empty permissionDenials, and clobber the renderer's
    // permissionDenied state — making the AskUserQuestion / ExitPlanMode card
    // never appear. ExitPlanMode was already handled; AskUserQuestion was the
    // missed case.
    const needsUserResponse = event.fields.permissionDenials?.some(
      (d: any) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion',
    )
    log(`engine_status: tabId=${tabId} task_complete synthesized denials=${event.fields.permissionDenials?.length ?? 0} needsUserResponse=${needsUserResponse}`)
    ctx.setStatus(tabId, needsUserResponse ? 'completed' : 'idle')
    ctx.checkDrain()
  } else if (event.fields.state === 'running') {
    if (tab.status !== 'running') {
      ctx.emit('event', tabId, {
        type: 'session_init',
        sessionId: tab.conversationId || '',
        tools: [],
        model: event.fields.model || '',
        mcpServers: [],
        skills: [],
        version: '',
        isWarmup: false,
      } as NormalizedEvent)
    }
    // A real run started: clear the surfaced-proposal dedup so the NEXT
    // proposal produced by this new work re-surfaces even if it happens to
    // carry an identical signature to the prior one (e.g. the model re-enters
    // plan mode and proposes the same plan file again).
    tab.lastSurfacedProposalSig = null
    ctx.setStatus(tabId, 'running')
  }
}

function handleDeadEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: Extract<EngineEvent, { type: 'engine_dead' }>,
): void {
  log(`engine_dead: tabId=${tabId} exitCode=${event.exitCode} signal=${event.signal} type=${typeof event.exitCode}`)
  if (event.exitCode === 0 || event.exitCode === null || event.exitCode === undefined) {
    tab.activeRequestId = null
    if (!event.signal) {
      tab.engineSessionStarted = false
    }
    if (tab.status !== 'completed') {
      ctx.setStatus(tabId, 'idle')
    }
    ctx.checkDrain()
    return
  }
  const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
  ctx.emit('error', tabId, {
    message: `Engine process exited with code ${event.exitCode}`,
    stderrTail: event.stderrTail || [],
    exitCode: event.exitCode ?? null,
    elapsedMs: durationMs,
    toolCallCount: tab.toolCallCount,
    sawPermissionRequest: tab.sawPermissionRequest,
  } as EnrichedError)
  tab.activeRequestId = null
  ctx.setStatus(tabId, 'dead')
  ctx.checkDrain()
}
