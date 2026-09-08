import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { getStudioBrowserWindow } from '../studio-browser-window-resolver'
import { setGraphCommandSender } from '../studio-graph/renderer-bridge'
import {
  parseGraphCommandResult,
  type StudioGraphCommand,
  type StudioGraphCommandResult,
} from '../../shared/studio-graph-types'

const TAG = 'studio-graph-ipc'

let commandSeq = 0

/**
 * Studio graph IPC: correlated graph tool commands, main → renderer.
 *
 * The same shape as the browser commands in `studio-browser.ts`, for the same
 * reason: main is the only party that knows whether a Studio window exists, so
 * a missing or wedged renderer produces a resolved refusal instead of a tool
 * call hanging forever. Replies are matched by callId AND sender, so a
 * non-Studio window cannot settle a pending command.
 */
export function registerStudioGraphIpc(): void {
  setGraphCommandSender((command, timeoutMs) => sendGraphCommand(command, timeoutMs))
  _log(TAG, 'studio graph command sender registered')
}

async function sendGraphCommand(command: StudioGraphCommand, timeoutMs: number): Promise<StudioGraphCommandResult> {
  const studio = getStudioBrowserWindow()
  if (!studio || studio.isDestroyed()) {
    return { callId: 'none', ok: false, error: 'the Ion Studio window is not open' }
  }
  const callId = `studio-graph-${++commandSeq}`
  const senderId = studio.webContents.id

  return new Promise<StudioGraphCommandResult>((resolve) => {
    let settled = false
    const onReply = (event: Electron.IpcMainEvent, payload: unknown): void => {
      const parsed = parseGraphCommandResult(payload)
      if (!parsed || parsed.callId !== callId) return
      if (event.sender.id !== senderId) {
        _warn(TAG, 'graph command reply rejected, sender is not the studio window', {
          call_id: callId,
          sender_id: event.sender.id,
          studio_id: senderId,
        })
        return
      }
      if (settled) {
        // A late reply cannot be delivered, but it means the timeout is too
        // tight for this command — otherwise indistinguishable from a wedged
        // renderer in the log.
        _warn(TAG, 'graph command reply arrived after timeout', { call_id: callId, timeout_ms: timeoutMs })
        return
      }
      settled = true
      clearTimeout(timer)
      ipcMain.off(IPC.STUDIO_GRAPH_COMMAND_RESULT, onReply)
      resolve(parsed)
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ipcMain.off(IPC.STUDIO_GRAPH_COMMAND_RESULT, onReply)
      _warn(TAG, 'graph command timed out', { call_id: callId, kind: command.kind, timeout_ms: timeoutMs })
      resolve({ callId, ok: false, error: `Studio did not answer the ${command.kind} graph command in time` })
    }, timeoutMs)

    ipcMain.on(IPC.STUDIO_GRAPH_COMMAND_RESULT, onReply)
    _log(TAG, 'graph command dispatched', { call_id: callId, kind: command.kind, conversation_id: command.conversationId })
    studio.webContents.send(IPC.STUDIO_GRAPH_COMMAND, { callId, command })
  })
}
