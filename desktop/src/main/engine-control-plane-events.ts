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
// elicitation/export/compaction/stall/steer arms plus handleDeadEvent.
// Status reconciliation lives in engine-control-plane-status-event.ts.
import type { EngineEvent, NormalizedEvent } from '../shared/types'
import { log as _log, debug as _debug, error as _error } from './logger'
import { handleExportEvent } from './engine-export-handler'
import { handleThinkingEvent } from './engine-control-plane-thinking'
import { handlePlanEvent } from './engine-control-plane-plan'
import { handleDispatchEvent } from './engine-control-plane-dispatch'
import { handleExtensionEvent } from './engine-control-plane-extension'
import { handleStreamSignalEvent } from './engine-control-plane-stream'
import { handleDeadEvent } from './engine-control-plane-dead'
import { handleStatusEvent } from './engine-control-plane-status-event'
import { mark, Activity } from './watchdog'
import { recordClientMsgId } from './remote/client-msg-id-map'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
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
  const repeatedStatusHeartbeat = event.type === 'engine_status'
    && event.fields?.state === tab.status
    && !(event.fields.permissionDenials?.length)
  if (!repeatedStatusHeartbeat) tab.lastActivityAt = Date.now()
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
        ...(event.imageContentHash ? { contentHash: event.imageContentHash } : {}),
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
      // entryId / userEntryId carry the canonical persisted tree-entry ids so
      // the reducer re-keys the live rows (event-slice-extension-surface.ts) —
      // previously dropped here, which left plain-tab desktop rows keyed by
      // renderer-local ids and caused history reloads to duplicate them.
      ctx.emit('event', tabId, {
        type: 'message_end',
        inputTokens: event.usage?.inputTokens,
        outputTokens: event.usage?.outputTokens,
        contextPercent: event.usage?.contextPercent,
        cost: event.usage?.cost,
        entryId: event.usage?.entryId,
        userEntryId: event.usage?.userEntryId,
      } as NormalizedEvent)
      // RC-9: record clientMsgId→entryId for history-row annotation (see
      // client-msg-id-map.ts). activeRequestId is the remote prompt's clientMsgId.
      recordClientMsgId(tabId, event.usage?.userEntryId, tab.activeRequestId)
      break

    case 'engine_user_turn_persisted':
      // The run-opening user turn's canonical persisted entry id, announced
      // before streaming. Forward to the renderer reducer so the optimistic
      // user row is re-keyed immediately — a run cancelled or failed
      // mid-stream never reaches a message_end, and without this the
      // un-re-keyed optimistic row duplicates against the persisted turn on
      // the next history load.
      log('user_turn_persisted', {
        tab_id: tabId,
        entry_id: event.userTurnEntryId,
        model_alias: event.userTurnSlashModelAlias,
        model: event.userTurnSlashModelEffective,
      })
      ctx.emit('event', tabId, {
        type: 'user_turn_persisted',
        entryId: event.userTurnEntryId,
        slashModelAlias: event.userTurnSlashModelAlias,
        slashModelEffective: event.userTurnSlashModelEffective,
      } as NormalizedEvent)
      // RC-9: also record here — a cancelled/failed run never reaches message_end.
      recordClientMsgId(tabId, event.userTurnEntryId, tab.activeRequestId)
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
        stderrTail: event.stderrTail ?? [],
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
        source: event.elicitSource,
        server: event.elicitServer,
        message: event.elicitMessage,
        action: event.elicitAction,
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
    case 'engine_run_recovery':
    case 'engine_background_task_started':
    case 'engine_background_task_terminal':
    case 'engine_session_work_stopped':
    case 'engine_steer_injected':
    case 'engine_steer_degraded':
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
    case 'engine_capability_unsupported':
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
