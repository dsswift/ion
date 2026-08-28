import { loadConversationTranscript } from '../../conversation-transcript'
import { log as _log } from '../../logger'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'

export async function handleRequestTranscript(
  cmd: Extract<RemoteCommand, { type: 'desktop_request_transcript' }>,
  deviceId: string,
): Promise<void> {
  try {
    const transcript = await loadConversationTranscript(cmd.tabId)
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_transcript', tabId: cmd.tabId, requestId: cmd.requestId,
      transcript,
    })
    _log('main', 'remote_transcript: response sent', { device_id: deviceId, tab_id: cmd.tabId, request_id: cmd.requestId, chars: transcript.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    _log('main', 'remote_transcript: request failed', { device_id: deviceId, tab_id: cmd.tabId, request_id: cmd.requestId, error: message })
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_transcript', tabId: cmd.tabId, requestId: cmd.requestId,
      transcript: '', error: message,
    })
  }
}
