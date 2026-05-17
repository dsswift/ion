import { log as _log } from '../../logger'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

// ─── Pending log request tracking ───

interface PendingLogRequest {
  resolve: (logs: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingLogRequest>()

/**
 * Request diagnostic logs from a connected iOS device.
 *
 * Sends a `request_diagnostic_logs` event to the device and waits for the
 * `diagnostic_logs_response` command to come back. Times out after 10 seconds.
 */
export function requestDiagnosticLogs(deviceId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Cancel any existing request for this device
    const existing = pendingRequests.get(deviceId)
    if (existing) {
      clearTimeout(existing.timer)
      existing.reject(new Error('Superseded by new request'))
    }

    const timer = setTimeout(() => {
      pendingRequests.delete(deviceId)
      reject(new Error('Diagnostic logs request timed out (10s)'))
    }, 10_000)

    pendingRequests.set(deviceId, { resolve, reject, timer })

    log(`requesting diagnostic logs from device ${deviceId}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'request_diagnostic_logs' })
  })
}

/**
 * Handle the `diagnostic_logs_response` command from an iOS device.
 */
export function handleDiagnosticLogsResponse(
  cmd: Extract<RemoteCommand, { type: 'diagnostic_logs_response' }>,
  deviceId: string,
): void {
  log(`received diagnostic logs from device ${deviceId} (${cmd.logs.length} bytes)`)

  const pending = pendingRequests.get(deviceId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingRequests.delete(deviceId)
    pending.resolve(cmd.logs)
  }
}

/**
 * Request logs from the first connected iOS device.
 * Returns the log text, or throws if no device is connected or the request times out.
 */
export async function requestLogsFromFirstDevice(): Promise<string> {
  const deviceIds = state.remoteTransport?.getConnectedDeviceIds() ?? []
  if (deviceIds.length === 0) {
    throw new Error('No iOS device connected')
  }
  return requestDiagnosticLogs(deviceIds[0])
}
