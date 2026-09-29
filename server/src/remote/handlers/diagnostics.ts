import { appendFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { hostName } from '../../host-name'
import { dataDir } from '../../paths'
import { log as _log, warn as _warn } from '../../logger'
import { atomicWriteFileSync } from '../../utils/atomicWrite'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warnLog(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/** Persisted log file path — readable by the engine's Read tool. */
function logFile(): string { return join(dataDir(), 'ios-diagnostic-logs.jsonl') }

/**
 * Persisted per-device seq cursor. Maps deviceId → the highest `nextSeq` the
 * device has reported. Survives a server restart so a relaunch resumes the
 * incremental pull instead of re-requesting (and re-appending) the device's
 * whole retained history. Written via atomicWriteFileSync (non-secret → 0o644).
 */
function seqMarkFile(): string { return join(dataDir(), 'ios-log-seq.json') }

/**
 * This server's hostname, cached once. Injected onto every persisted iOS log
 * line as `fields.desktop_host` (the field keeps its original name) so the
 * central sink can attribute an iOS device to the server that collected it:
 * a desktop's own server, or a remote one. Matches the telemetry `host` value
 * for the same machine, enabling correlation to the Ion Fleet board.
 */
const COLLECTOR_HOST = hostName()

/**
 * Size cap for this server's iOS log file. When the file exceeds this limit
 * after an append, it is rename-rotated to keep local disk use bounded.
 * 10 MB keeps the footprint small.
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
    size = statSync(logFile()).size
  } catch {
    return // file absent — nothing to rotate
  }
  if (size < IOS_LOG_MAX_BYTES) return

  // Delete oldest generation, shift remaining ones up, rename live to .1.
  try { unlinkSync(logFile() + '.' + IOS_LOG_MAX_GENERATIONS) } catch { /* silent-ok: oldest generation may not exist yet */ }
  for (let i = IOS_LOG_MAX_GENERATIONS - 1; i >= 1; i--) {
    try { renameSync(logFile() + '.' + i, logFile() + '.' + (i + 1)) } catch { /* silent-ok: generation i may not exist yet */ }
  }
  try { renameSync(logFile(), logFile() + '.1') } catch { /* silent-ok: best-effort rotate; next write recreates the live file */ }
  log('log_pull: ios log rotated', { path: logFile(), size_bytes: size })
}

/** How often to pull logs while a device is connected (ms). Configurable for tests. */
export const PERIODIC_LOG_PULL_INTERVAL_MS = 5_000

// ─── Per-device seq cursor (persisted, exactly-once resume) ──────────────────

/**
 * In-memory cache of the persisted per-device seq marks, loaded lazily from
 * seqMarkFile() on first access. Maps deviceId → highest `nextSeq` reported.
 * On each pull we send this value as `sinceSeq` so iOS returns only lines whose
 * `fields.seq` exceeds it. After persisting a response we advance and persist
 * the mark. Because it is disk-backed, a server restart resumes rather than
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
    if (existsSync(seqMarkFile())) {
      const parsed = JSON.parse(readFileSync(seqMarkFile(), 'utf-8')) as Record<string, number>
      for (const [deviceId, seq] of Object.entries(parsed)) {
        if (typeof seq === 'number' && Number.isFinite(seq)) deviceSeqMark.set(deviceId, seq)
      }
      log('log_pull: loaded seq marks', { count: deviceSeqMark.size, path: seqMarkFile() })
    } else {
      log('log_pull: no persisted seq marks', { path: seqMarkFile() })
    }
  } catch (err) {
    // Corrupt mark file: start fresh rather than crash. A full re-pull is the
    // safe fallback (dedup on seq below still prevents duplicate appends).
    log('log_pull: seq mark load failed, starting fresh', { error: (err as Error).message })
  }
}

/** The highest `nextSeq` this server has persisted for `deviceId`: where that client's next batch should start. */
export function diagnosticLogCursor(deviceId: string): number {
  return getSeqMark(deviceId)
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
    atomicWriteFileSync(seqMarkFile(), JSON.stringify(obj), 0o644)
  } catch (err) {
    log('log_pull: seq mark persist failed', { device_id: deviceId, error: (err as Error).message })
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
 * Inject collector-side identity into one parsed iOS log line and dedup on seq.
 *
 * The server stamps what only IT knows — the pairing_id (the ECDH channel ID
 * that links logs to a specific pairing session) and this server's
 * hostname — into the line's `fields`. iOS already stamped what only it knows
 * (device_id from identifierForVendor, device_model, app_version, os_version,
 * seq, and optionally mdm_device_id/mdm_serial). Together every iOS line is
 * individually attributable downstream: which hardware device, which app build,
 * paired to which server session.
 *
 * Returns the re-serialized line, or null when the line is a duplicate (its
 * `seq` is at or below `sinceSeq` — a reconnect/overlap re-send) and must be
 * skipped. Malformed lines (unparseable JSON, or no numeric seq) are passed
 * through UNCHANGED with `passthrough=true` so a bad payload never silently
 * drops a log entry (logging rule: no silent drop).
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
    fields.desktop_host = COLLECTOR_HOST
    obj.fields = fields
    return { out: JSON.stringify(obj), passthrough: false, seq: null }
  }
  if (seq <= sinceSeq) {
    // Already persisted on a prior pull — drop the duplicate.
    return { out: null, passthrough: false, seq }
  }
  fields.pairing_id = pairingId
  fields.desktop_host = COLLECTOR_HOST
  obj.fields = fields
  return { out: JSON.stringify(obj), passthrough: false, seq }
}

/**
 * Persist a log chunk from iOS to ~/.ion/ios-diagnostic-logs.jsonl.
 *
 * Each incoming line is parsed, stamped with collector-side identity
 * (pairing_id / desktop_host) inside its `fields`, and appended. iOS already
 * stamped the stable per-device identity (device_id, device_model, app_version,
 * os_version, mdm_device_id, mdm_serial). Lines whose `seq` is at or below the
 * persisted cursor are dropped as duplicates (exactly-once against
 * reconnect/restart overlap). Malformed lines pass through unchanged and bump a
 * debug-logged tolerance counter — never a silent drop. Returns whether the
 * chunk is safely on disk (nothing to write counts as safe); the caller
 * advances the seq mark only then.
 *
 * Every line must remain a valid JSON object so Alloy/LogQL parsers can
 * consume the JSONL file.
 */
function persistLogChunk(logs: string, pairingId: string, sinceSeq: number): boolean {
  if (!logs.trim()) {
    log('log_pull: no new lines', { pairing_id: pairingId })
    return true
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
    return true
  }
  const payload = kept.join('\n') + '\n'
  try {
    mkdirSync(dataDir(), { recursive: true })
    if (existsSync(logFile())) {
      appendFileSync(logFile(), payload, 'utf-8')
    } else {
      writeFileSync(logFile(), payload, 'utf-8')
    }
    log('log_pull: appended lines', { count: kept.length, duplicates, malformed, pairing_id: pairingId, path: logFile() })
  } catch (err) {
    // The mark stays put, so the next pull asks for these lines again. The
    // device keeps every line its server has not confirmed.
    warnLog('log_pull: persist failed; lines will be pulled again', {
      pairing_id: pairingId,
      count: kept.length,
      path: logFile(),
      error: (err as Error).message,
    })
    return false
  }
  // Rotate the iOS log file if it has grown past the size cap.
  rotateIosLogIfNeeded()
  return true
}

/**
 * Surface lines the device wrote but did not send. The device's cursor passes
 * over them for good, so they never arrive on a later pull. A line with no
 * pairing_id is never exported to any server, which makes a non-zero
 * `withheldUnstamped` a loss of device logs and a WARN. Lines that belong to a
 * different pairing are isolation working as intended and log at INFO.
 */
function reportWithheldLines(
  cmd: Extract<RemoteCommand, { type: 'desktop_diagnostic_logs_response' }>,
  deviceId: string,
): void {
  const unstamped = cmd.withheldUnstamped ?? 0
  const otherPairing = cmd.withheldOtherPairing ?? 0
  if (unstamped > 0) {
    warnLog('log_pull: device withheld lines that carry no pairing id', {
      device_id: deviceId,
      pairing_id: cmd.pairingId,
      withheld_unstamped: unstamped,
      next_seq: cmd.nextSeq,
    })
  }
  if (otherPairing > 0) {
    log('log_pull: device withheld lines that belong to another pairing', {
      device_id: deviceId,
      pairing_id: cmd.pairingId,
      withheld_other_pairing: otherPairing,
      next_seq: cmd.nextSeq,
    })
  }
}

/**
 * Handle the `diagnostic_logs_response` command from an iOS device.
 * Resolves any pending promise AND appends new, identity-stamped lines to the
 * log file (dropping any whose seq is at or below the persisted cursor).
 * Advances and persists the per-device seq mark to the response's `nextSeq`
 * only once the lines are on disk. The device reads the mark back as `sinceSeq`
 * and treats it as confirmation that it may delete those lines.
 *
 * Seq-space regression: when the device reports a `nextSeq` BELOW the persisted
 * mark, the device's seq space has reset (app reinstall / device reset) and the
 * mark points beyond anything the device will ever send — every future pull
 * would return nothing (or the same overlap) forever. The mark is reset to the
 * reported `nextSeq` so pulls resume from the device's actual position. This
 * check runs on EVERY response, which also covers the first response after a
 * device connect. Any response also clears the device's no-response backoff.
 */
export function handleDiagnosticLogsResponse(
  cmd: Extract<RemoteCommand, { type: 'desktop_diagnostic_logs_response' }>,
  deviceId: string,
): void {
  const lineCount = cmd.logs ? cmd.logs.split('\n').filter((l) => l.trim()).length : 0
  log('log_pull: received', { device_id: deviceId, bytes: cmd.logs?.length ?? 0, lines: lineCount, next_seq: cmd.nextSeq })

  // The device answered — clear any no-response backoff so periodic pulls
  // resume at the base interval.

  reportWithheldLines(cmd, deviceId)

  const sinceSeq = getSeqMark(deviceId)
  let dedupSince = sinceSeq
  let regressedTo: number | null = null

  // Seq-space regression check — MUST run before persistLogChunk, otherwise
  // the stale (too-high) mark would dedup-drop every line the reset device sends.
  if (typeof cmd.nextSeq === 'number' && cmd.nextSeq < sinceSeq) {
    warnLog('log_pull: device seq space regressed, resetting mark', {
      device_id: deviceId,
      old_mark: sinceSeq,
      reported_next_seq: cmd.nextSeq,
    })
    regressedTo = cmd.nextSeq
    // Dedup cursor for THIS chunk is 0: the device's new seq space has nothing
    // persisted yet, so nothing in the chunk can be a duplicate. Both the old
    // mark and the reset mark would wrongly drop every line (all seqs in the
    // chunk are below cmd.nextSeq by definition).
    dedupSince = 0
  }

  const persisted = persistLogChunk(cmd.logs ?? '', cmd.pairingId, dedupSince)

  // A regressed mark resets to the device's position once its lines are
  // saved, or to 0 so the next pull asks for them again.
  if (regressedTo !== null) setSeqMark(deviceId, persisted ? regressedTo : 0)

  // Advance the persisted seq mark so the next pull (and any post-restart pull)
  // requests only lines newer than what we have. Guard against a stale/absent
  // nextSeq: never move the cursor backward here (regression handling above is
  // the sole sanctioned backward move).
  if (persisted && regressedTo === null && typeof cmd.nextSeq === 'number' && cmd.nextSeq > sinceSeq) {
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

