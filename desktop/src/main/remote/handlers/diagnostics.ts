import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log } from '../../logger'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/** Persisted log file path — readable by the engine's Read tool. */
const LOG_FILE = join(homedir(), '.ion', 'ios-diagnostic-logs.txt')

// ─── Pending log request tracking ───

interface PendingLogRequest {
  resolve: (logs: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingLogRequest>()

/**
 * Write logs to ~/.ion/ios-diagnostic-logs.txt so the engine can read them.
 */
function persistLogs(logs: string, deviceName: string): void {
  try {
    mkdirSync(join(homedir(), '.ion'), { recursive: true })
    const header = `# iOS Diagnostic Logs — ${deviceName}\n# Pulled at ${new Date().toISOString()}\n\n`
    writeFileSync(LOG_FILE, header + logs, 'utf-8')
    log(`persisted iOS logs to ${LOG_FILE} (${logs.length} bytes)`)
  } catch (err) {
    log(`failed to persist iOS logs: ${(err as Error).message}`)
  }
}

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
 * Resolves any pending promise AND writes logs to disk for engine access.
 */
export function handleDiagnosticLogsResponse(
  cmd: Extract<RemoteCommand, { type: 'diagnostic_logs_response' }>,
  deviceId: string,
): void {
  log(`received diagnostic logs from device ${deviceId} (${cmd.logs.length} bytes)`)

  persistLogs(cmd.logs, cmd.deviceName)

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

/**
 * Auto-pull diagnostic logs from a device. Called on sync (device connect/reconnect).
 * Fire-and-forget — errors are logged but do not propagate.
 */
export function autoPullDiagnosticLogs(deviceId: string): void {
  log(`auto-pulling diagnostic logs from device ${deviceId}`)
  requestDiagnosticLogs(deviceId).catch((err) => {
    log(`auto-pull diagnostic logs failed: ${(err as Error).message}`)
  })
}
