import { appendFile, appendFileSync, statSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { dataDir } from './paths'
import { shipToEgress } from '@ion/shared/log-egress'
import { admitLogLine, drainSuppressions, _resetForTest as resetRateLimitForTest } from '@ion/shared/log-rate-limit'
import { correlate, lineFields, _resetForTest as resetCorrelationForTest } from '@ion/shared/log-correlation'
import { setLogSink } from '@ion/shared/log-sink'

/**
 * Resolved fresh on every call, never cached at module scope: a top-level
 * `= dataDir()` runs the moment anything imports this file, which breaks any
 * bundle target that cannot run real Node fs/path/os at import time (the
 * Studio renderer imports the session store, which imports the logger
 * transitively, purely to compile).
 */
function logDir(): string {
  return logDirOverride ?? dataDir()
}
function logFile(): string {
  return join(logDir(), 'server.jsonl')
}
/**
 * Where log lines go: `file` (default), `stdout`, or `both`. Named after the
 * relay's own `RELAY_LOG_OUTPUT` so the two read the same way.
 *
 * The file is the default because that is what every local install reads, and
 * because under the desktop this process's stdout is already captured and
 * re-logged -- `both` there would record every line twice. In a container it
 * is the opposite: the file goes away with the pod and `docker logs` was
 * empty, because nothing was ever written to stdout. The server's Dockerfile
 * therefore sets `both`.
 */
type LogOutput = 'file' | 'stdout' | 'both'

function logOutput(): LogOutput {
  const raw = (process.env.ION_LOG_OUTPUT ?? '').trim().toLowerCase()
  if (raw === 'stdout' || raw === 'both' || raw === 'file') return raw
  return 'file'
}

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
 *
 * `component` is `'server'` for everything this module itself writes.
 * `'web'` is the one exception: `http/log-ingest.ts`'s `POST /log` route
 * forwards a browser client's own log lines (spec 18) and those describe
 * BROWSER-side behavior, not this Node process's -- stamping them `server`
 * would misattribute every web-client failure to the wrong component in the
 * schema's `component` enum (`docs/observability/log-schema.md`).
 */
interface LogLine {
  ts: string
  level: LogLevel
  component: 'server' | 'web'
  tag?: string
  msg: string
  session_id?: string
  conversation_id?: string
  trace_id?: string
  fields: Record<string, unknown>
}

let minLevel: LogLevel = 'INFO'
let buffer: string[] = []
let timer: ReturnType<typeof setInterval> | null = null
let bytesWritten = 0
let bytesInitialized = false
let disableRotation = false
/**
 * A fixed directory for the log file instead of `dataDir()` (test use). The
 * test setup pins it to the worker's home: a test that points ION_DATA_DIR at
 * a temp directory and deletes it afterwards would otherwise race the
 * logger's async append, which can recreate server.jsonl mid-delete.
 */
let logDirOverride: string | null = null

/**
 * Stable machine-identity fields stamped on every log line. Populated once via
 * initLoggerMachineIdentity() at app startup; empty until then. They win over
 * a caller field of the same name: log pipelines label each line with the
 * device these keys name, so a caller's `host` meaning a URL's host must not
 * relabel the line (scripts/check-logging.sh RESERVED-KEY keeps call sites
 * off these keys).
 */
let ambientMachineFields: Record<string, string> = {}

/** All chunks handed to async appendFile not yet confirmed written */
const inFlight = new Map<number, string>()
let nextChunkId = 1

/**
 * Writes that failed since the last successful one, and the bytes they took
 * with them. Reported as an ERROR line the moment a write succeeds again --
 * see `flush`'s callback for why this counter exists rather than a log call
 * at the point of failure.
 */
let writeFailures = 0
let writeFailureBytes = 0

/**
 * RFC3339Nano UTC timestamp. Date#toISOString yields millisecond precision
 * ending in `Z`; pad the fractional part out to nanoseconds so the line
 * conforms to the canonical schema.
 */
function nowRfc3339Nano(): string {
  return new Date().toISOString().replace('Z', '') + '000000Z'
}

function serialize(component: 'server' | 'web', level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): string {
  // Machine identity wins over a caller field of the same name. `pid` is
  // always stamped: two server processes once wrote interleaved lines to one
  // server.jsonl (an orphaned child and its successor), and nothing on a line
  // said which process wrote it.
  const mergedFields = { pid: process.pid, ...(fields ?? {}), ...ambientMachineFields }
  const line: LogLine = {
    ts: nowRfc3339Nano(),
    level,
    component,
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
  // A caller states a line's prompt trace as a `trace_id` field; it is a
  // top-level key, so it leaves `fields` once lifted (see lineFields).
  if (ids.trace_id) line.trace_id = ids.trace_id
  line.fields = lineFields(mergedFields, tag)
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
    mkdirSync(logDir(), { recursive: true })
  } catch {
    // Directory creation failure (permissions, read-only fs) surfaces on the
    // next appendFile call; nothing useful to do here — the logger cannot
    // log its own bootstrap failure.
  }
  try {
    bytesWritten = statSync(logFile()).size
  } catch {
    bytesWritten = 0
  }
}

/**
 * Rename-rotate: shift existing generations (.2→.3, .1→.2) up to
 * MAX_LOG_GENERATIONS, then rename the live file to .1 and let the next write
 * create a fresh server.jsonl. The live file is renamed (not truncated) so the
 * egress tailer detects the inode change, drains the old fd to EOF, and follows
 * the new file — no bytes are lost in the rotation gap. Generations beyond
 * MAX_LOG_GENERATIONS are deleted before shifting.
 */
function rotate(): void {
  if (disableRotation) return
  // Delete the oldest generation to make room, then shift each generation up.
  try { unlinkSync(logFile() + '.' + maxLogGenerations) } catch { /* oldest generation may not exist yet */ }
  for (let i = maxLogGenerations - 1; i >= 1; i--) {
    try { renameSync(logFile() + '.' + i, logFile() + '.' + (i + 1)) } catch { /* generation i may not exist yet */ }
  }
  // Rename the live file to .1; next write creates a fresh server.jsonl.
  // A failure here means rotation silently stopped and the file grows
  // unbounded — surface it on stderr since we cannot log to the file itself.
  try {
    renameSync(logFile(), logFile() + '.1')
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
  // Resolved once, here: `logFile()` re-reads the data directory on every
  // call, so reporting a failure with a freshly-resolved path can name a
  // different file than the one the write actually attempted.
  const target = logFile()
  appendFile(target, chunk, (err) => {
    inFlight.delete(chunkId)
    if (!err) {
      // A write succeeding is what clears the alarm: report the run of lines
      // the failures ate, on the first line that actually reaches the file.
      if (writeFailures > 0) {
        const lost = writeFailures
        const lostBytes = writeFailureBytes
        writeFailures = 0
        writeFailureBytes = 0
        emitLine(serialize('server', 'ERROR', 'logger', 'log file writes failed; lines were lost', {
          failed_writes: lost,
          lost_bytes: lostBytes,
        }), 'ERROR')
      }
      return
    }
    // The logger cannot report its own write failure through itself -- that
    // report would take the same broken path. stderr is the only channel
    // left, and the counter above makes the loss visible in the file itself
    // the moment writing recovers. Discarding this error (which is what this
    // callback used to do) is the worst option of the three: it makes a log
    // file that is silently missing lines look exactly like one with nothing
    // to say, which is the failure mode AGENTS.md's "No silent failures"
    // rule exists to prevent.
    writeFailures += 1
    writeFailureBytes += chunk.length
    try {
      process.stderr.write(`[logger] append to ${target} failed; ${chunk.length} bytes lost: ${String(err)}\n`)
    } catch { /* stderr unavailable; the counter above is the remaining record */ }
  })
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

function logAt(level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): void {
  logAtComponent('server', level, tag, msg, fields)
}

/**
 * Same as `logAt` but with an explicit `component`. Exported (as `logWeb`
 * below) for `http/log-ingest.ts`'s `POST /log` route (spec 18), which
 * forwards a browser client's OWN log lines and must stamp them `component:
 * 'web'` rather than `'server'` -- see `LogLine`'s docstring.
 */
/**
 * Returns whether the line was admitted to the file. A caller that has to
 * answer someone else about the line's fate -- `POST /log`, which tells a
 * browser client whether its forwarded line survived -- needs to distinguish
 * "written" from "dropped by the level filter or the rate limiter". Every
 * in-process caller ignores the result, which is why this stayed `void` until
 * a remote caller needed the answer.
 */
function logAtComponent(component: 'server' | 'web', level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): boolean {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return false

  // Per-message rate limit. A runaway loop must not be able to rotate the log
  // window that holds the evidence of itself — see log-rate-limit.ts. Withheld
  // lines are counted and the count is emitted, never dropped silently.
  const decision = admitLogLine(level, tag, msg, Date.now())
  if (decision.summary) {
    emitLine(serialize('server', 'WARN', 'logger', 'log lines suppressed by rate limit', {
      suppressed_key: decision.summary.key,
      log_suppressed: decision.summary.count,
      window_ms: decision.summary.windowMs,
    }), 'WARN')
  }
  if (!decision.allow) return false

  const line = serialize(component, level, tag, msg, fields)

  // Ship to egress forwarder (non-blocking; no-op when egress is not configured).
  // Build the record directly from serialized fields to avoid double JSON.parse.
  //
  // EXCEPTION: the egress subsystem's OWN operational logs (tags prefixed
  // "log_egress") are never fed back into egress. Shipping them would create a
  // feedback loop — every drain/flush logs, that log becomes a record to ship,
  // the next drain logs again — unbounded self-amplification that keeps the
  // spool growing on its own. These lines still land in server.jsonl for local
  // observability (the drain-path instrumentation is fully visible there); they
  // simply do not recurse into the egress buffer.
  if (!tag.startsWith('log_egress')) {
    const egressRec: import('@ion/shared/log-egress').EgressRecord = {
      ts: new Date().toISOString().replace('Z', '') + '000000Z',
      level,
      msg,
      component,
      fields: lineFields(fields ?? {}, tag),
    }
    if (tag) egressRec.tag = tag
    // Same per-line resolution as the file record above: the egress copy must
    // carry the same IDs as the line it mirrors, or a remote query and a local
    // `jq` would disagree about which conversation a line belongs to.
    const egressIds = correlate({ fields: fields ?? {} })
    if (egressIds.session_id) egressRec.session_id = egressIds.session_id
    if (egressIds.conversation_id) egressRec.conversation_id = egressIds.conversation_id
    if (egressIds.trace_id) egressRec.trace_id = egressIds.trace_id
    shipToEgress(egressRec)
  }

  emitLine(line, level)
  return true
}

/**
 * Commit one serialized line to the file.
 *
 * Split out of logAt so the rate limiter's suppression summary reaches the file
 * through the same write path as any other line — including its rotation
 * accounting — without re-entering logAt and being rate-limited itself.
 */
function emitLine(line: string, level: LogLevel): void {
  // Written first, and unbuffered: a stream consumer (`docker logs`, a
  // service manager's journal) is reading live, so a line held for the file's
  // 500ms batch would arrive out of order with the ones around it.
  const output = logOutput()
  if (output !== 'file') {
    try {
      process.stdout.write(line)
    } catch {
      // A closed or full stdout must never take down the process; the file
      // copy below is the durable record either way.
    }
  }
  if (output === 'stdout') return

  // ERROR lines are written synchronously so a crash immediately after an
  // error cannot lose the diagnostic. They bypass the async buffer entirely.
  if (level === 'ERROR') {
    initBytes()
    if (bytesWritten >= MAX_FILE_SIZE) rotate()
    bytesWritten += line.length
    appendFileSync(logFile(), line)
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

/**
 * Configure logger behavior. `disableRotation` skips rotation and `dir` pins
 * the log file's directory (both test use).
 */
export function configureLogger(opts: { disableRotation?: boolean; maxGenerations?: number; dir?: string }): void {
  if (typeof opts.disableRotation === 'boolean') disableRotation = opts.disableRotation
  if (typeof opts.dir === 'string') {
    logDirOverride = opts.dir
    bytesInitialized = false
  }
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
 * Logs one line on behalf of a browser Studio client (spec 18), stamped
 * `component: 'web'` instead of `'server'`. `http/log-ingest.ts`'s `POST
 * /log` route is the only caller -- see `LogLine`'s docstring for why the
 * component distinction matters.
 */
export function logWeb(level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): boolean {
  return logAtComponent('web', level, tag, msg, fields)
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
    buffer.push(serialize('server', 'WARN', 'logger', 'log lines suppressed by rate limit', {
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
      appendFileSync(logFile(), pending)
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
  logDirOverride = null
  maxLogGenerations = MAX_LOG_GENERATIONS
  resetCorrelationForTest()
  ambientMachineFields = {}
  inFlight.clear()
  nextChunkId = 1
  resetRateLimitForTest()
}

/**
 * Hand this process's logger to the shared log-shipping stack.
 *
 * Those modules run here AND in Electron's main process, so they cannot
 * import either logger directly -- a build-time choice would file one
 * process's lines under the other's component. Registered at module load, so
 * a line written before boot finishes still lands here.
 */
setLogSink((level, tag, msg, fields) => {
  logAtComponent('server', level, tag, msg, fields)
})
