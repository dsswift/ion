import { appendFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, hostname } from 'os'
import { log as _log } from '../../logger'
import { atomicWriteFileSync } from '../../utils/atomicWrite'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/** Persisted log file path — readable by the engine's Read tool. */
const LOG_FILE = join(homedir(), '.ion', 'ios-diagnostic-logs.jsonl')

/**
 * Persisted per-device seq cursor. Maps deviceId → the highest `nextSeq` the
 * device has reported. Survives desktop restart so a relaunch resumes the
 * incremental pull instead of re-requesting (and re-appending) the device's
 * whole retained history. Written via atomicWriteFileSync (non-secret → 0o644).
 */
const SEQ_MARK_FILE = join(homedir(), '.ion', 'ios-log-seq.json')

/**
 * This desktop's hostname, cached once. Injected onto every persisted iOS log
 * line as `fields.desktop_host` so the central sink can attribute an iOS
 * device to the desktop that collected it. Matches the telemetry `host` value
 * for the same machine, enabling manual correlation to the Ion Fleet board.
 */
const DESKTOP_HOST = hostname().replace(/\.local$/, '')

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

// ─── Per-device seq cursor (persisted, exactly-once resume) ──────────────────

/**
 * In-memory cache of the persisted per-device seq marks, loaded lazily from
 * SEQ_MARK_FILE on first access. Maps deviceId → highest `nextSeq` reported.
 * On each pull we send this value as `sinceSeq` so iOS returns only lines whose
 * `fields.seq` exceeds it. After persisting a response we advance and persist
 * the mark. Because it is disk-backed, a desktop restart resumes rather than
 * re-pulling from 0.
 *
 * Exported for test access.
 */
export const deviceSeqMark = new Map<string, number>()

let seqMarksLoaded = false

/** Load persisted seq marks into the in-memory cache once. */
function loadSeqMarks(): void {
  if (seqMarksLoaded) return
  seqMarksLoaded = true
  try {
    if (existsSync(SEQ_MARK_FILE)) {
      const parsed = JSON.parse(readFileSync(SEQ_MARK_FILE, 'utf-8')) as Record<string, number>
      for (const [deviceId, seq] of Object.entries(parsed)) {
        if (typeof seq === 'number' && Number.isFinite(seq)) deviceSeqMark.set(deviceId, seq)
      }
      log('log_pull: loaded seq marks', { count: deviceSeqMark.size, path: SEQ_MARK_FILE })
    } else {
      log('log_pull: no persisted seq marks', { path: SEQ_MARK_FILE })
    }
  } catch (err) {
    // Corrupt mark file: start fresh rather than crash. A full re-pull is the
    // safe fallback (dedup on seq below still prevents duplicate appends).
    log('log_pull: seq mark load failed, starting fresh', { error: (err as Error).message })
  }
}

/** Read the persisted seq mark for a device (0 when unseen). */
function getSeqMark(deviceId: string): number {
  loadSeqMarks()
  return deviceSeqMark.get(deviceId) ?? 0
}

/** Advance and persist a device's seq mark. */
function setSeqMark(deviceId: string, nextSeq: number): void {
  loadSeqMarks()
  deviceSeqMark.set(deviceId, nextSeq)
  try {
    const obj = Object.fromEntries(deviceSeqMark)
    atomicWriteFileSync(SEQ_MARK_FILE, JSON.stringify(obj), 0o644)
  } catch (err) {
    log('log_pull: seq mark persist failed', { device_id: deviceId, error: (err as Error).message })
  }
}

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
      const sinceSeq = getSeqMark(deviceId)
      log('log_pull: periodic pull', { device_id: deviceId, since_seq: sinceSeq })
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_request_diagnostic_logs', sinceSeq })
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
 * Inject desktop-side identity into one parsed iOS log line and dedup on seq.
 *
 * The desktop stamps what only IT knows — the pairing_id (the ECDH channel ID
 * that links logs to a specific desktop pairing session) and this desktop's
 * hostname — into the line's `fields`. iOS already stamped what only it knows
 * (device_id from identifierForVendor, device_model, app_version, os_version,
 * seq, and optionally mdm_device_id/mdm_serial). Together every iOS line is
 * individually attributable downstream: which hardware device, which app build,
 * paired to which desktop session.
 *
 * Returns the re-serialized line, or null when the line is a duplicate (its
 * `seq` is at or below `sinceSeq` — a reconnect/overlap re-send) and must be
 * skipped. Malformed lines (unparseable JSON, or no numeric seq) are passed
 * through UNCHANGED with `passthrough=true` so a bad payload never silently
 * drops a log entry (desktop logging rule: no silent drop).
 */
function injectIdentity(
  line: string,
  pairingId: string,
  sinceSeq: number,
): { out: string | null; passthrough: boolean; seq: number | null } {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { out: line, passthrough: true, seq: null }
  }
  const fields = (obj.fields ?? {}) as Record<string, unknown>
  const rawSeq = fields.seq
  const seq = typeof rawSeq === 'number' ? rawSeq : typeof rawSeq === 'string' ? Number(rawSeq) : NaN
  if (!Number.isFinite(seq)) {
    // Parseable JSON but no usable seq — inject identity but cannot dedup.
    fields.pairing_id = pairingId
    fields.desktop_host = DESKTOP_HOST
    obj.fields = fields
    return { out: JSON.stringify(obj), passthrough: false, seq: null }
  }
  if (seq <= sinceSeq) {
    // Already persisted on a prior pull — drop the duplicate.
    return { out: null, passthrough: false, seq }
  }
  fields.pairing_id = pairingId
  fields.desktop_host = DESKTOP_HOST
  obj.fields = fields
  return { out: JSON.stringify(obj), passthrough: false, seq }
}

/**
 * Persist a log chunk from iOS to ~/.ion/ios-diagnostic-logs.jsonl.
 *
 * Each incoming line is parsed, stamped with desktop-side identity
 * (pairing_id / desktop_host) inside its `fields`, and appended. iOS already
 * stamped the stable per-device identity (device_id, device_model, app_version,
 * os_version, mdm_device_id, mdm_serial). Lines whose `seq` is at or below the
 * persisted cursor are dropped as duplicates (exactly-once against
 * reconnect/restart overlap). Malformed lines pass through unchanged and bump a
 * debug-logged tolerance counter — never a silent drop. Returns nothing; the
 * caller advances the seq mark from the response's `nextSeq`.
 *
 * Every line must remain a valid JSON object so Alloy/LogQL parsers can
 * consume the JSONL file.
 */
function persistLogChunk(logs: string, pairingId: string, sinceSeq: number): void {
  if (!logs.trim()) {
    log('log_pull: no new lines', { pairing_id: pairingId })
    return
  }
  const incoming = logs.split('\n').filter((l) => l.trim())
  const kept: string[] = []
  let duplicates = 0
  let malformed = 0
  for (const line of incoming) {
    const { out, passthrough } = injectIdentity(line, pairingId, sinceSeq)
    if (passthrough) malformed++
    if (out === null) {
      duplicates++
      continue
    }
    kept.push(out)
  }
  if (malformed > 0) {
    log('log_pull: malformed lines passed through', { pairing_id: pairingId, count: malformed })
  }
  if (kept.length === 0) {
    log('log_pull: all lines were duplicates', { pairing_id: pairingId, duplicates })
    return
  }
  const payload = kept.join('\n') + '\n'
  try {
    mkdirSync(join(homedir(), '.ion'), { recursive: true })
    if (existsSync(LOG_FILE)) {
      appendFileSync(LOG_FILE, payload, 'utf-8')
    } else {
      writeFileSync(LOG_FILE, payload, 'utf-8')
    }
    log('log_pull: appended lines', { count: kept.length, duplicates, malformed, pairing_id: pairingId, path: LOG_FILE })
    // Rotate the iOS log file if it has grown past the size cap.
    rotateIosLogIfNeeded()
  } catch (err) {
    log('log_pull: persist failed', { pairing_id: pairingId, error: (err as Error).message })
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

    const sinceSeq = getSeqMark(deviceId)
    log('log_pull: requesting', { device_id: deviceId, since_seq: sinceSeq })
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_request_diagnostic_logs', sinceSeq })
  })
}

/**
 * Handle the `diagnostic_logs_response` command from an iOS device.
 * Resolves any pending promise AND appends new, identity-stamped lines to the
 * log file (dropping any whose seq is at or below the persisted cursor).
 * Advances and persists the per-device seq mark to the response's `nextSeq`.
 */
export function handleDiagnosticLogsResponse(
  cmd: Extract<RemoteCommand, { type: 'desktop_diagnostic_logs_response' }>,
  deviceId: string,
): void {
  const lineCount = cmd.logs ? cmd.logs.split('\n').filter((l) => l.trim()).length : 0
  log('log_pull: received', { device_id: deviceId, bytes: cmd.logs?.length ?? 0, lines: lineCount, next_seq: cmd.nextSeq })

  const sinceSeq = getSeqMark(deviceId)
  persistLogChunk(cmd.logs ?? '', cmd.pairingId, sinceSeq)

  // Advance the persisted seq mark so the next pull (and any post-restart pull)
  // requests only lines newer than what we have. Guard against a stale/absent
  // nextSeq: never move the cursor backward.
  if (typeof cmd.nextSeq === 'number' && cmd.nextSeq > sinceSeq) {
    setSeqMark(deviceId, cmd.nextSeq)
    log('log_pull: seq mark updated', { device_id: deviceId, from: sinceSeq, to: cmd.nextSeq })
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
 * Resumes from the PERSISTED seq mark — a reconnect (or a desktop restart) pulls
 * only lines newer than what is already on disk, so history is never re-appended.
 * Fire-and-forget — errors are logged but do not propagate. Also starts the
 * periodic pull interval if not already running.
 */
export function autoPullDiagnosticLogs(deviceId: string): void {
  // Resume from the persisted cursor — do NOT reset to 0 (that re-ships history).
  loadSeqMarks()
  log('log_pull: auto-pulling on connect', { device_id: deviceId, since_seq: getSeqMark(deviceId) })
  requestDiagnosticLogs(deviceId).catch((err) => {
    log('log_pull: auto-pull failed', { error: (err as Error).message })
  })
  // Start the periodic interval so subsequent pulls are incremental.
  startPeriodicLogPull()
}
