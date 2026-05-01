import type { EngineBridge } from './engine-bridge'
import type { EngineEvent, NormalizedEvent, TabStatus, EnrichedError } from '../shared/types'
import { log as _log, debug as _debug, error as _error } from './logger'

const TAG = 'SessionPlane'
function log(msg: string): void { _log(TAG, msg) }
function debug(msg: string): void { _debug(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

export interface TabEntry {
  tabId: string
  status: TabStatus
  activeRequestId: string | null
  conversationId: string | null
  engineSessionStarted: boolean
  lastActivityAt: number
  promptCount: number
  permissionMode: 'auto' | 'plan'
  approvedTools: string[]
  startedAt: number
  toolCallCount: number
  sawPermissionRequest: boolean
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
      if (event.usage) {
        log(`message_end: tabId=${tabId} in=${event.usage.inputTokens} out=${event.usage.outputTokens} cost=$${event.usage.cost ?? 0}`)
        ctx.emit('event', tabId, {
          type: 'usage',
          usage: {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
          },
        } as NormalizedEvent)
      }
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

    case 'engine_dialog':
      ctx.emit('event', tabId, {
        type: 'dialog' as any,
        dialogId: event.dialogId,
        method: event.method,
        title: event.title,
        message: event.message,
        options: event.options,
        defaultValue: event.defaultValue,
      } as any)
      break

    case 'engine_working_message':
      break

    case 'engine_notify':
      if (event.level === 'error') {
        ctx.emit('event', tabId, {
          type: 'error',
          message: event.message,
          isError: true,
        } as NormalizedEvent)
      }
      break

    case 'engine_plan_mode_changed':
      log(`plan_mode_changed: tabId=${tabId} enabled=${event.planModeEnabled}`)
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

    case 'engine_agent_state':
      ctx.emit('event', tabId, event as any)
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
  if (event.fields.state === 'idle') {
    if (event.fields.sessionId) {
      tab.conversationId = event.fields.sessionId
      ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
    }

    if (tab.status === 'completed') {
      log(`engine_status: skipping duplicate idle for completed tab ${tabId}`)
      return
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
    const hasExitPlan = event.fields.permissionDenials?.some((d: any) => d.toolName === 'ExitPlanMode')
    ctx.setStatus(tabId, hasExitPlan ? 'completed' : 'idle')
    ctx.checkDrain()
  } else if (event.fields.state === 'running') {
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
