import type { RemoteCommand } from '../protocol'
import { log as _log, warn as _warn } from '../../logger'
import { engineBridge, state } from '../../state'

function log(msg: string, fields?: Record<string, unknown>): void { _log('main', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('main', msg, fields) }

/** Stop one exact background Bash task and answer only the requesting device. */
export async function handleStopBackgroundTask(
  cmd: Extract<RemoteCommand, { type: 'desktop_stop_background_task' }>,
  deviceId: string,
): Promise<void> {
  if (!cmd.taskId || !cmd.requestId) {
    warn('remote_stop_background_task: invalid request', { tab_id: cmd.tabId, task_id: cmd.taskId, request_id: cmd.requestId })
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_background_task_stop_result',
      requestId: cmd.requestId || '',
      taskId: cmd.taskId || '',
      status: 'invalid',
      error: 'taskId and requestId are required',
    })
    return
  }

  log('remote_stop_background_task: requesting stop', { tab_id: cmd.tabId, task_id: cmd.taskId, request_id: cmd.requestId, device_id: deviceId })
  try {
    const result = await engineBridge.stopBackgroundTask(cmd.tabId, cmd.taskId)
    const status = result.status ?? (result.ok ? 'stopped' : 'failed')
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_background_task_stop_result',
      requestId: cmd.requestId,
      taskId: cmd.taskId,
      status,
      ...(result.error ? { error: result.error } : {}),
    })
    log('remote_stop_background_task: result sent', { tab_id: cmd.tabId, task_id: cmd.taskId, request_id: cmd.requestId, status, device_id: deviceId })
  } catch (err) {
    const error = String(err)
    warn('remote_stop_background_task: failed', { tab_id: cmd.tabId, task_id: cmd.taskId, request_id: cmd.requestId, error })
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_background_task_stop_result',
      requestId: cmd.requestId,
      taskId: cmd.taskId,
      status: 'failed',
      error,
    })
  }
}
