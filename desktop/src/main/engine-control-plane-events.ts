// Translation layer EngineEvent→NormalizedEvent covering every engine_* wire
// type. The switch below routes each engine_* event to a NormalizedEvent (or a
// side-effecting handler). To keep every file under the 600-line cap, the
// domain-clustered arms are extracted into sibling files that share the
// TabEntry / EventEmitterContext types (defined in
// engine-control-plane-events-types.ts and re-exported here):
//   - engine-control-plane-thinking.ts   (thinking channel)
//   - engine-control-plane-plan.ts       (plan-mode lifecycle)
//   - engine-control-plane-dispatch.ts   (dispatch / agent-state telemetry)
//   - engine-control-plane-extension.ts  (extension lifecycle / harness / misc)
// This file retains the tool/text/message/error/permission/notify/dialog/
// elicitation/export/compaction/stall/steer arms plus handleStatusEvent and
// handleDeadEvent.
import type { EngineEvent, NormalizedEvent, EnrichedError, EngineConfig } from '../shared/types'
import { log as _log, debug as _debug, warn as _warn, error as _error, trace as _trace } from './logger'
import { handleExportEvent } from './engine-export-handler'
import { handleThinkingEvent } from './engine-control-plane-thinking'
import { handlePlanEvent } from './engine-control-plane-plan'
import { handleDispatchEvent } from './engine-control-plane-dispatch'
import { handleExtensionEvent } from './engine-control-plane-extension'
import { handleStreamSignalEvent } from './engine-control-plane-stream'
import { conversationExists } from './session-meta'
import { mark, Activity } from './watchdog'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function trace(msg: string, fields?: Record<string, unknown>): void { _trace(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error(TAG, msg, fields) }

// TabEntry and EventEmitterContext are defined in the sibling types module
// (extracted to keep this file and its domain-split siblings under the
// 600-line cap). Re-exported here so existing import sites that reach them
// through this module keep resolving unchanged.
export type { TabEntry, EventEmitterContext } from './engine-control-plane-events-types'
import type { TabEntry, EventEmitterContext } from './engine-control-plane-events-types'

export function handleEngineEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: EngineEvent,
): void {
  // Watchdog breadcrumb: this is the per-event entry point for every engine
  // event forwarded through the main process. If the main thread wedges while
  // spinning here, the watchdog worker sees this code with a climbing counter.
  mark(Activity.EngineEvent)
  tab.lastActivityAt = Date.now()
  debug('event', { tab_id: tabId, type: event.type })

  switch (event.type) {
    case 'engine_text_delta':
      ctx.emit('event', tabId, { type: 'text_chunk', text: event.text } as NormalizedEvent)
      break

    case 'engine_tool_start':
      tab.toolCallCount++
      log('tool_start', { tab_id: tabId, tool: event.toolName, tool_id: event.toolId, count: tab.toolCallCount })
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
      debug('tool_end', { tab_id: tabId, tool_id: event.toolId, is_error: event.isError })
      ctx.emit('event', tabId, {
        type: 'tool_result',
        toolId: event.toolId,
        content: event.result || '',
        isError: event.isError || false,
      } as NormalizedEvent)
      break

    case 'engine_image_content':
      // A single run-produced image (tool-returned or provider-generated). The
      // engine saved the bytes to disk and emitted the FILE PATH (never base64).
      // Translate to the `image_content` NormalizedEvent the renderer's
      // event-slice-images materializer consumes so it attaches to the right
      // message (tool image → producing tool row by toolId; provider image →
      // latest assistant row). Without this arm the event was dropped before
      // ever reaching the renderer, so desktop-side inline images never
      // rendered live and never persisted — the root cause of the #224 gap on
      // the desktop (iOS received it via the generic wire forwarder).
      debug('image_content', { tab_id: tabId, source: event.imageSource, tool_id: event.imageToolId ?? '', path: event.imagePath })
      ctx.emit('event', tabId, {
        type: 'image_content',
        path: event.imagePath,
        mediaType: event.imageMediaType,
        source: event.imageSource,
        ...(event.imageToolId ? { toolId: event.imageToolId } : {}),
      } as NormalizedEvent)
      break

    case 'engine_message_end':
      // End of one LLM message within a multi-turn run. Carries per-message
      // token usage (for the context bar) and seals the current assistant row
      // (prevents the next text_chunk from appending to it).
      if (event.usage) {
        log('message_end', { tab_id: tabId, input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens, cost_usd: event.usage.cost ?? 0 })
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
      error('engine_error', { tab_id: tabId, error: event.message })
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
      log('permission_request', { tab_id: tabId, tool: event.permToolName })
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
    case 'engine_plan_file_written':
    case 'engine_plan_mode_auto_exit':
    case 'engine_plan_proposal':
      handlePlanEvent(ctx, tabId, tab, event)
      break

    case 'engine_stream_reset':
    case 'engine_compacting':
    case 'engine_tool_stalled':
    case 'engine_run_stalled':
    case 'engine_steer_injected':
    case 'engine_prompt_injected':
      handleStreamSignalEvent(ctx, tabId, tab, event)
      break

    case 'engine_thinking_block_start':
    case 'engine_thinking_delta':
    case 'engine_thinking_block_end':
      handleThinkingEvent(ctx, tabId, tab, event)
      break

    case 'engine_agent_state':
    case 'engine_dispatch_start':
    case 'engine_dispatch_end':
      handleDispatchEvent(ctx, tabId, tab, event)
      break

    case 'engine_harness_message':
    case 'engine_extension_died':
    case 'engine_extension_respawned':
    case 'engine_extension_dead_permanent':
    case 'engine_events_dropped':
    case 'engine_model_fallback':
      handleExtensionEvent(ctx, tabId, tab, event)
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
      handleExtensionEvent(ctx, tabId, tab, event)
      break

    case 'engine_export':
      // The engine has rendered a /export payload. Surface the save-as
      // dialog so the user can write it to disk. The engine_command_result
      // arrives next and is handled by the existing result-routing path.
      // exportFormat is the engine-resolved format (markdown/json/html/jsonl);
      // the handler maps it to a file extension without sniffing the payload.
      log('export', { tab_id: tabId, format: event.exportFormat ?? 'absent', payload_bytes: event.message?.length ?? 0 })
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
  // Per-status (fires on every heartbeat tick across every session): logged at
  // DEBUG so the default INFO level filters it before serialization. State
  // transitions of note (first-bind, divergence resume) stay at INFO/WARN below.
  debug('engine_status', { tab_id: tabId, state: event.fields.state, session_id: event.fields.sessionId ?? 'none', cost_usd: event.fields.runCostUsd ?? 0 })
  // Forward the full StatusFields snapshot to the renderer BEFORE the
  // state-binding branches below. The renderer's `status` arm replaces
  // inst.statusFields wholesale (snapshot semantics). This is unconditional —
  // every engine_status, all states — so the renderer's statusFields tracks
  // model/backend/cost/extensionName on running, idle, and cost-only heartbeat
  // ticks alike, not just on idle (the binding/task_complete path below drops
  // those fields). The emit is additive; the existing binding logic is unchanged.
  debug('engine_status: forwarding to renderer', { tab_id: tabId, state: event.fields.state, model: event.fields.model ?? 'none', backend: event.fields.backend ?? 'api' })
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
        log('engine_status: first-bind adopting engine sessionId', { tab_id: tabId, session_id: event.fields.sessionId })
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
      debug('engine_status: session-ready idle, forwarding', { tab_id: tabId, status: tab.status })
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
      trace('engine_status: skipping idle, new run in flight', { tab_id: tabId })
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
      trace('engine_status: skipping idle, no denials', { tab_id: tabId, status: tab.status })
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
        log('engine_status: skipping proposal idle, already surfaced', { tab_id: tabId, status: tab.status, proposal_sig: proposalSig })
        return
      }
      tab.lastSurfacedProposalSig = proposalSig
      // Log the first delivery so the decision is reconstructable from
      // desktop.log (logging policy: log both branches).
      const toolNames = (event.fields.permissionDenials || [])
        .map((d: any) => d.toolName)
        .join(',')
      log('engine_status: forwarding proposal idle', { tab_id: tabId, status: tab.status, tool_names: toolNames, proposal_sig: proposalSig })
    }

    const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
    ctx.emit('event', tabId, {
      type: 'task_complete',
      result: '',
      costUsd: event.fields.runCostUsd || 0,
      durationMs,
      numTurns: event.fields.numTurns ?? 1,
      conversationTurns: event.fields.conversationTurns,
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
    log('engine_status: task_complete synthesized', { tab_id: tabId, denials: event.fields.permissionDenials?.length ?? 0, needs_user_response: needsUserResponse })
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
  log('engine_dead', { tab_id: tabId, exit_code: event.exitCode, signal: event.signal })
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
