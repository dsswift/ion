import { appendFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log } from '../../logger'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/** Persisted log file path — readable by the engine's Read tool. */
const LOG_FILE = join(homedir(), '.ion', 'ios-diagnostic-logs.jsonl')

/**
 * Size cap for the desktop-side iOS log file. When the file exceeds this limit
 * after an append, it is rename-rotated to keep local disk use bounded.
 * 10 MB keeps the footprint small; iOS on-device caps at 10 MB too.
 */
const IOS_LOG_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Number of rotated archive generations to keep alongside the live
 * ios-diagnostic-logs.jsonl. At 10 MB cap and 2 generations, the maximum
 * local footprint is ~30 MB.
 */
const IOS_LOG_MAX_GENERATIONS = 2

/**
 * Rename-rotate the iOS diagnostic log file when it exceeds IOS_LOG_MAX_BYTES.
 * Shifts existing generations (.1→.2, up to IOS_LOG_MAX_GENERATIONS) then
 * renames the live file to .1 so the next append creates a fresh file.
 * The egress tailer detects the inode change, drains the old fd, and follows
 * the new file — no lines are lost in the rotation gap.
 */
function rotateIosLogIfNeeded(): void {
  let size = 0
  try {
    size = statSync(LOG_FILE).size
  } catch {
    return // file absent — nothing to rotate
  }
  if (size < IOS_LOG_MAX_BYTES) return

  // Delete oldest generation, shift remaining ones up, rename live to .1.
  try { unlinkSync(LOG_FILE + '.' + IOS_LOG_MAX_GENERATIONS) } catch {}
  for (let i = IOS_LOG_MAX_GENERATIONS - 1; i >= 1; i--) {
    try { renameSync(LOG_FILE + '.' + i, LOG_FILE + '.' + (i + 1)) } catch {}
  }
  try { renameSync(LOG_FILE, LOG_FILE + '.1') } catch {}
  log('log_pull: ios log rotated', { path: LOG_FILE, size_bytes: size })
}

/** How often to pull logs while a device is connected (ms). Configurable for tests. */
export const PERIODIC_LOG_PULL_INTERVAL_MS = 5_000

// ─── Per-device high-water mark (cumulative line count already persisted) ────

/**
 * Tracks how many log lines we have already persisted for each device.
 * On each pull we send this count as `lineOffset` so iOS only returns
 * new lines. After persisting the response we advance the mark.
 *
 * Exported for test access.
 */
export const deviceLogLineOffset = new Map<string, number>()

// ─── Periodic pull interval ───────────────────────────────────────────────────

let periodicInterval: ReturnType<typeof setInterval> | null = null

/**
 * Start the periodic log-pull interval. Fires every PERIODIC_LOG_PULL_INTERVAL_MS
 * while at least one device is connected. Safe to call multiple times — only one
 * interval is active at any time.
 */
export function startPeriodicLogPull(): void {
  if (periodicInterval) return
  log('log_pull: starting periodic log pull', { interval_ms: PERIODIC_LOG_PULL_INTERVAL_MS })
  periodicInterval = setInterval(() => {
    const deviceIds = state.remoteTransport?.getConnectedDeviceIds() ?? []
    if (deviceIds.length === 0) {
      // Nothing connected — stop the interval to avoid spinning.
      stopPeriodicLogPull()
      return
    }
    for (const deviceId of deviceIds) {
      const lineOffset = deviceLogLineOffset.get(deviceId) ?? 0
      log('log_pull: periodic pull', { device_id: deviceId, line_offset: lineOffset })
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_request_diagnostic_logs', lineOffset })
    }
  }, PERIODIC_LOG_PULL_INTERVAL_MS)
}

/**
 * Stop the periodic log-pull interval (called on all-devices-disconnect
 * and on test teardown).
 */
export function stopPeriodicLogPull(): void {
  if (periodicInterval) {
    clearInterval(periodicInterval)
    periodicInterval = null
    log('stopPeriodicLogPull: periodic log pull stopped')
  }
}

// ─── Pending log request tracking ────────────────────────────────────────────

interface PendingLogRequest {
  resolve: (logs: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingLogRequest>()

/**
 * Persist a log chunk from iOS to ~/.ion/ios-diagnostic-logs.jsonl.
 *
 * Append-correct: if `logs` is non-empty and the file already exists, we
 * append rather than overwrite. This preserves history from earlier pulls.
 * Each call represents `newLineCount` new lines (computed from the response)
 * so the caller can advance the device's high-water mark after persisting.
 *
 * Every line must remain a valid JSON object so Alloy/LogQL parsers can
 * consume the JSONL file.
 */
function persistLogChunk(logs: string, deviceId: string): void {
  if (!logs.trim()) {
    log('log_pull: no new lines', { device_id: deviceId })
    return
  }
  try {
    mkdirSync(join(homedir(), '.ion'), { recursive: true })
    if (existsSync(LOG_FILE)) {
      appendFileSync(LOG_FILE, logs, 'utf-8')
    } else {
      writeFileSync(LOG_FILE, logs, 'utf-8')
    }
    // Count lines appended for the log summary (blank-line-safe).
    const lineCount = logs.split('\n').filter((l) => l.trim()).length
    log('log_pull: appended lines', { count: lineCount, device_id: deviceId, path: LOG_FILE })
    // Rotate the iOS log file if it has grown past the size cap.
    rotateIosLogIfNeeded()
  } catch (err) {
    log('log_pull: persist failed', { device_id: deviceId, error: (err as Error).message })
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
    // Cancel any existing request for this device.
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

    const lineOffset = deviceLogLineOffset.get(deviceId) ?? 0
    log('log_pull: requesting', { device_id: deviceId, line_offset: lineOffset })
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_request_diagnostic_logs', lineOffset })
  })
}

/**
 * Handle the `diagnostic_logs_response` command from an iOS device.
 * Resolves any pending promise AND appends new lines to the log file.
 * Advances the per-device high-water mark by the line count received.
 */
export function handleDiagnosticLogsResponse(
  cmd: Extract<RemoteCommand, { type: 'desktop_diagnostic_logs_response' }>,
  deviceId: string,
): void {
  const newLineCount = cmd.logs ? cmd.logs.split('\n').filter((l) => l.trim()).length : 0
  log('log_pull: received', { device_id: deviceId, bytes: cmd.logs?.length ?? 0, lines: newLineCount })

  persistLogChunk(cmd.logs ?? '', deviceId)

  // Advance the high-water mark so the next pull requests only newer lines.
  if (newLineCount > 0) {
    const prev = deviceLogLineOffset.get(deviceId) ?? 0
    deviceLogLineOffset.set(deviceId, prev + newLineCount)
    log('log_pull: line offset updated', { device_id: deviceId, from: prev, to: prev + newLineCount })
  }

  const pending = pendingRequests.get(deviceId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingRequests.delete(deviceId)
    pending.resolve(cmd.logs ?? '')
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
 * Resets the high-water mark to 0 on reconnect so we get the full history from
 * fresh. Fire-and-forget — errors are logged but do not propagate.
 * Also starts the periodic pull interval if not already running.
 */
export function autoPullDiagnosticLogs(deviceId: string): void {
  // Reset high-water mark on reconnect — full history pull.
  deviceLogLineOffset.set(deviceId, 0)
  log('log_pull: auto-pulling on connect', { device_id: deviceId })
  requestDiagnosticLogs(deviceId).catch((err) => {
    log('log_pull: auto-pull failed', { error: (err as Error).message })
  })
  // Start the periodic interval so subsequent pulls are incremental.
  startPeriodicLogPull()
}
