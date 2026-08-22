import { appendFile, appendFileSync, statSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { shipToEgress } from './log-egress'
import { admitLogLine, drainSuppressions, _resetForTest as resetRateLimitForTest } from './log-rate-limit'
import { correlate, _resetForTest as resetCorrelationForTest } from './log-correlation'

const LOG_DIR = join(homedir(), '.ion')
const LOG_FILE = join(LOG_DIR, 'desktop.jsonl')
const FLUSH_INTERVAL_MS = 500
const MAX_BUFFER_SIZE = 64
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
/** Default number of rotated archive files kept alongside the live log file. */
const MAX_LOG_GENERATIONS = 3
/** Active generation count — overridable via configureLogger for tests. */
let maxLogGenerations = MAX_LOG_GENERATIONS

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_ORDER: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 }

/**
 * One serialized log line per the unified log schema (docs/observability/log-schema.md).
 * Optional ID fields are omitted entirely when not in scope, never emitted as "".
 */
interface LogLine {
  ts: string
  level: LogLevel
  component: 'desktop'
  tag?: string
  msg: string
  session_id?: string
  conversation_id?: string
  fields: Record<string, unknown>
}

let minLevel: LogLevel = 'INFO'
let buffer: string[] = []
let timer: ReturnType<typeof setInterval> | null = null
let bytesWritten = 0
let bytesInitialized = false
let disableRotation = false

/**
 * Stable machine-identity fields stamped on every log line. Populated once via
 * initLoggerMachineIdentity() at app startup; empty until then. Caller-supplied
 * fields in each log call take precedence over these ambient values.
 */
let ambientMachineFields: Record<string, string> = {}

/** All chunks handed to async appendFile not yet confirmed written */
const inFlight = new Map<number, string>()
let nextChunkId = 1

/**
 * RFC3339Nano UTC timestamp. Date#toISOString yields millisecond precision
 * ending in `Z`; pad the fractional part out to nanoseconds so the line
 * conforms to the canonical schema.
 */
function nowRfc3339Nano(): string {
  return new Date().toISOString().replace('Z', '') + '000000Z'
}

function serialize(level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): string {
  // Ambient machine-identity fields fill absent keys; caller fields win on collision.
  const mergedFields = Object.keys(ambientMachineFields).length > 0
    ? { ...ambientMachineFields, ...(fields ?? {}) }
    : (fields ?? {})
  const line: LogLine = {
    ts: nowRfc3339Nano(),
    level,
    component: 'desktop',
    msg,
    fields: mergedFields,
  }
  if (tag) line.tag = tag
  // Correlation IDs are resolved from THIS line's own subject — never from an
  // ambient "current session" global. A single global is wrong in a process
  // that runs many conversations at once: the last session to start overwrote
  // the stamp for every subsequent line, so filtering by conversation_id
  // returned a neighbour's lines and omitted real ones. See log-correlation.ts.
  const ids = correlate({ fields: mergedFields })
  if (ids.session_id) line.session_id = ids.session_id
  if (ids.conversation_id) line.conversation_id = ids.conversation_id
  return JSON.stringify(line) + '\n'
}

function initBytes(): void {
  if (bytesInitialized) return
  bytesInitialized = true
  // Ensure the log directory exists before the first write. In production the
  // engine daemon creates ~/.ion long before the desktop starts, but nothing
  // guarantees it in every environment (fresh machine, CI runner, plain-Node
  // vitest): appendFile[Sync] creates missing FILES, never missing
  // DIRECTORIES, so a missing ~/.ion turned every ERROR-level log into an
  // ENOENT throw from the logger itself.
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    // Directory creation failure (permissions, read-only fs) surfaces on the
    // next appendFile call; nothing useful to do here — the logger cannot
    // log its own bootstrap failure.
  }
  try {
    bytesWritten = statSync(LOG_FILE).size
  } catch {
    bytesWritten = 0
  }
}

/**
 * Rename-rotate: shift existing generations (.2→.3, .1→.2) up to
 * MAX_LOG_GENERATIONS, then rename the live file to .1 and let the next write
 * create a fresh desktop.jsonl. The live file is renamed (not truncated) so the
 * egress tailer detects the inode change, drains the old fd to EOF, and follows
 * the new file — no bytes are lost in the rotation gap. Generations beyond
 * MAX_LOG_GENERATIONS are deleted before shifting.
 */
function rotate(): void {
  if (disableRotation) return
  // Delete the oldest generation to make room, then shift each generation up.
  try { unlinkSync(LOG_FILE + '.' + maxLogGenerations) } catch { /* oldest generation may not exist yet */ }
  for (let i = maxLogGenerations - 1; i >= 1; i--) {
    try { renameSync(LOG_FILE + '.' + i, LOG_FILE + '.' + (i + 1)) } catch { /* generation i may not exist yet */ }
  }
  // Rename the live file to .1; next write creates a fresh desktop.jsonl.
  // A failure here means rotation silently stopped and the file grows
  // unbounded — surface it on stderr since we cannot log to the file itself.
  try {
    renameSync(LOG_FILE, LOG_FILE + '.1')
  } catch (err) {
    try { process.stderr.write(`[logger] rotate rename failed; rotation stalled: ${String(err)}\n`) } catch { /* stderr unavailable */ }
  }
  bytesWritten = 0
  bytesInitialized = false
}

function flush(): void {
  if (buffer.length === 0) return
  initBytes()
  if (bytesWritten >= MAX_FILE_SIZE) rotate()
  const chunk = buffer.join('')
  buffer = []
  const chunkId = nextChunkId++
  inFlight.set(chunkId, chunk)
  bytesWritten += chunk.length
  appendFile(LOG_FILE, chunk, () => { inFlight.delete(chunkId) })
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

function logAt(level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  // Per-message rate limit. A runaway loop must not be able to rotate the log
  // window that holds the evidence of itself — see log-rate-limit.ts. Withheld
  // lines are counted and the count is emitted, never dropped silently.
  const decision = admitLogLine(level, tag, msg, Date.now())
  if (decision.summary) {
    emitLine(serialize('WARN', 'logger', 'log lines suppressed by rate limit', {
      suppressed_key: decision.summary.key,
      log_suppressed: decision.summary.count,
      window_ms: decision.summary.windowMs,
    }), 'WARN')
  }
  if (!decision.allow) return

  const line = serialize(level, tag, msg, fields)

  // Ship to egress forwarder (non-blocking; no-op when egress is not configured).
  // Build the record directly from serialized fields to avoid double JSON.parse.
  //
  // EXCEPTION: the egress subsystem's OWN operational logs (tags prefixed
  // "log_egress") are never fed back into egress. Shipping them would create a
  // feedback loop — every drain/flush logs, that log becomes a record to ship,
  // the next drain logs again — unbounded self-amplification that keeps the
  // spool growing on its own. These lines still land in desktop.jsonl for local
  // observability (the drain-path instrumentation is fully visible there); they
  // simply do not recurse into the egress buffer.
  if (!tag.startsWith('log_egress')) {
    const egressRec: import('./log-egress').EgressRecord = {
      ts: new Date().toISOString().replace('Z', '') + '000000Z',
      level,
      msg,
      component: 'desktop',
      fields: fields ?? {},
    }
    if (tag) egressRec.tag = tag
    // Same per-line resolution as the file record above: the egress copy must
    // carry the same IDs as the line it mirrors, or a remote query and a local
    // `jq` would disagree about which conversation a line belongs to.
    const egressIds = correlate({ fields: fields ?? {} })
    if (egressIds.session_id) egressRec.session_id = egressIds.session_id
    if (egressIds.conversation_id) egressRec.conversation_id = egressIds.conversation_id
    shipToEgress(egressRec)
  }

  emitLine(line, level)
}

/**
 * Commit one serialized line to the file.
 *
 * Split out of logAt so the rate limiter's suppression summary reaches the file
 * through the same write path as any other line — including its rotation
 * accounting — without re-entering logAt and being rate-limited itself.
 */
function emitLine(line: string, level: LogLevel): void {
  // ERROR lines are written synchronously so a crash immediately after an
  // error cannot lose the diagnostic. They bypass the async buffer entirely.
  if (level === 'ERROR') {
    initBytes()
    if (bytesWritten >= MAX_FILE_SIZE) rotate()
    bytesWritten += line.length
    appendFileSync(LOG_FILE, line)
    return
  }

  buffer.push(line)
  if (buffer.length >= MAX_BUFFER_SIZE) flush()
  ensureTimer()
}

/** Set the minimum log level. Messages below this level are discarded. */
export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/**
 * Stamp stable machine-identity fields onto every subsequent log line.
 * Called once at app startup after loadMachineIdentity() resolves. Non-empty
 * values only: an empty string is never stamped (mirrors the Go rule).
 */
export function initLoggerMachineIdentity(identity: {
  host: string
  machineId: string
  mdmDeviceId: string
  mdmSerial: string
}): void {
  const fields: Record<string, string> = {}
  if (identity.host) fields.host = identity.host
  if (identity.machineId) fields.machine_id = identity.machineId
  if (identity.mdmDeviceId) fields.mdm_device_id = identity.mdmDeviceId
  if (identity.mdmSerial) fields.mdm_serial = identity.mdmSerial
  ambientMachineFields = fields
}

/** Configure logger behavior. `disableRotation` skips rotation (test use). */
export function configureLogger(opts: { disableRotation?: boolean; maxGenerations?: number }): void {
  if (typeof opts.disableRotation === 'boolean') disableRotation = opts.disableRotation
  if (typeof opts.maxGenerations === 'number' && opts.maxGenerations > 0) {
    maxLogGenerations = opts.maxGenerations
  }
}

/** Backward-compatible log function (INFO level). */
export function log(tag: string, msg: string, fields?: Record<string, unknown>): void {
  logAt('INFO', tag, msg, fields)
}

export function trace(tag: string, msg: string, fields?: Record<string, unknown>): void {
  logAt('TRACE', tag, msg, fields)
}

export function debug(tag: string, msg: string, fields?: Record<string, unknown>): void {
  logAt('DEBUG', tag, msg, fields)
}

export function info(tag: string, msg: string, fields?: Record<string, unknown>): void {
  logAt('INFO', tag, msg, fields)
}

export function warn(tag: string, msg: string, fields?: Record<string, unknown>): void {
  logAt('WARN', tag, msg, fields)
}

export function error(tag: string, msg: string, fields?: Record<string, unknown>): void {
  logAt('ERROR', tag, msg, fields)
}

/**
 * Synchronously drain all pending logs. Call on shutdown to guarantee
 * every buffered or in-flight line is persisted before the process exits.
 */
export function flushLogs(): void {
  if (timer) { clearInterval(timer); timer = null }
  // A storm that stopped just before exit has no successor line to carry its
  // withheld count. Drain them into the buffer before it is written out, so the
  // limiter never takes a count to the grave with it.
  for (const summary of drainSuppressions()) {
    buffer.push(serialize('WARN', 'logger', 'log lines suppressed by rate limit', {
      suppressed_key: summary.key,
      log_suppressed: summary.count,
      window_ms: summary.windowMs,
    }))
  }
  initBytes()
  if (bytesWritten >= MAX_FILE_SIZE) rotate()
  const pendingInflight = Array.from(inFlight.values()).join('')
  const pending = pendingInflight + buffer.join('')
  inFlight.clear()
  buffer = []
  if (pending) {
    bytesWritten += pending.length
    try {
      appendFileSync(LOG_FILE, pending)
    } catch (err) {
      // The logger cannot log its own final-drain failure to the same file.
      // Fall back to stderr so buffered lines don't vanish without a trace.
      try { process.stderr.write(`[logger] flushLogs append failed: ${String(err)}\n`) } catch { /* stderr unavailable */ }
    }
  }
}

/**
 * TEST ONLY. Reset all module-level state between test cases. Not for use in
 * shipped code paths.
 */
export function _resetForTest(): void {
  if (timer) { clearInterval(timer); timer = null }
  minLevel = 'INFO'
  buffer = []
  bytesWritten = 0
  bytesInitialized = false
  disableRotation = false
  maxLogGenerations = MAX_LOG_GENERATIONS
  resetCorrelationForTest()
  ambientMachineFields = {}
  inFlight.clear()
  nextChunkId = 1
  resetRateLimitForTest()
}

export { LOG_FILE }
