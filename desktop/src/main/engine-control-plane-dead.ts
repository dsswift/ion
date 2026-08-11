import type { EngineEvent, EnrichedError } from '../shared/types'
import { log } from './logger'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'

/** Handle terminal engine-process state and release any queued prompt drain. */
export function handleDeadEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: Extract<EngineEvent, { type: 'engine_dead' }>,
): void {
  log('SessionPlane', 'engine_dead', { tab_id: tabId, exit_code: event.exitCode, signal: event.signal })
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
