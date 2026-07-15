/**
 * log-egress-tailer.ts — file-tail forwarder for engine, iOS, and telemetry logs.
 *
 * Tails three files and ships their lines verbatim to the active egress forwarder:
 *   - ~/.ion/engine.jsonl        (engine and extension logs)
 *   - ~/.ion/ios-diagnostic-logs.jsonl  (iOS client logs)
 *   - ~/.ion/telemetry.jsonl     (cost telemetry — ships downstream)
 *
 * Key design points:
 *   - Lines are forwarded as-is. component / tag fields are NOT rewritten.
 *   - Persistent cursors (log-egress-cursors.ts): restarts resume at the last
 *     shipped offset rather than gapping or re-shipping. Written after each
 *     successful ship pass. At-least-once contract: duplicates possible on crash
 *     between ship and cursor write.
 *   - Rename-rotation correctness (fd-held draining): the tailer holds the file
 *     descriptor open. Each poll compares the path inode to the held fd inode.
 *     When they differ (file was renamed), the held fd is drained to EOF first
 *     (ships the orphaned tail bytes that today's stat-only design loses), then
 *     the new file is opened at offset 0.
 *   - Truncate-in-place (same inode, size < offset): resets offset to 0.
 *   - Tailing is decoupled from the desktop logger's own write path. No
 *     desktop log lines are double-shipped via this path — they go through
 *     shipToEgress() directly in logger.ts.
 */

import { open, close, read, fstat, stat } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'
import { shipTailedToEgress, type EgressRecord } from './log-egress'
import {
  loadCursors,
  saveCursors,
  fileIdForFd,
  type CursorMap,
  type CursorEntry,
} from './log-egress-cursors'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log_egress_tailer', msg, fields)
}

// ---------------------------------------------------------------------------
// Injectable ship function seam (test only — production uses shipToEgress)
// ---------------------------------------------------------------------------

/** The function used to ship records. Swapped out in tests via _setShipFnForTest.
 * Production uses shipTailedToEgress: tailed sources bypass the own-records
 * gate so a desktop assigned only tailed sources still ships them. */
let _shipFn: (rec: EgressRecord) => void = shipTailedToEgress

/**
 * TEST ONLY. Override the ship function so tests can capture shipped records
 * without monkey-patching the imported module binding.
 */
export function _setShipFnForTest(fn: (rec: EgressRecord) => void): void {
  _shipFn = fn
}

/**
 * TEST ONLY. Restore the ship function to the production default.
 */
export function _restoreShipFnForTest(): void {
  _shipFn = shipTailedToEgress
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const ENGINE_LOG_FILE = join(homedir(), '.ion', 'engine.jsonl')
export const IOS_LOG_FILE = join(homedir(), '.ion', 'ios-diagnostic-logs.jsonl')
export const TELEMETRY_LOG_FILE = join(homedir(), '.ion', 'telemetry.jsonl')

// ---------------------------------------------------------------------------
// Single-file tailer
// ---------------------------------------------------------------------------

const TAIL_POLL_INTERVAL_MS = 2_000
const READ_CHUNK_BYTES = 65_536 // 64 KiB per read pass
export interface TailerState {
  path: string
  /** Current byte offset in the held fd. */
  offset: number
  /** File descriptor held open (avoids TOCTOU on rename detection). -1 = not open. */
  fd: number
  /** Identity of the currently-held fd (inode or size-based fallback). */
  fdFileId: string
  timer: ReturnType<typeof setInterval> | null
  stopped: boolean
  remainder: string
  /**
   * True while a poll pass is in flight. A poll pass is a chain of async fs
   * callbacks (open/fstat/stat/read) plus the recursive drainFd loop; it can
   * outlast the poll interval on a slow disk or a large rename-drain. This flag
   * is the single-flight guard: the interval skips a tick while a pass is still
   * running so two passes never mutate the shared fd/offset concurrently. Without
   * it, one pass can close(fd)→fd=-1 while another's read(fd) is still queued,
   * yielding ERR_OUT_OF_RANGE (fd -1) inside drainFd/read.
   */
  polling: boolean
}

/**
 * Parse and ship complete JSONL lines from `chunk`, using `remainder` for
 * any partial line carried over from a previous read. Returns the new
 * remainder (empty string when chunk ended with '\n').
 */
function processChunk(chunk: string, remainder: string): string {
  const data = remainder + chunk
  const lines = data.split('\n')
  const newRemainder = lines.pop() ?? ''

  for (const line of lines) {
    if (!line.trim()) continue
    let rec: EgressRecord
    try {
      rec = JSON.parse(line) as EgressRecord
    } catch {
      // Malformed line — skip without logging (would cause recursive egress noise).
      continue
    }
    _shipFn(rec)
  }

  return newRemainder
}

/**
 * Perform one polling pass for a tailer.
 *
 * Algorithm:
 *   1. If no fd is held, open the file (skip if absent).
 *   2. fstat(fd) for growth. stat(path) to detect rename (inode change).
 *   3. Rename detected: drain held fd to EOF → close → open new file at 0.
 *   4. Truncate detected (same inode, size < offset): reset to 0.
 *   5. Drain all new bytes to EOF via drainFd (saves cursor per chunk).
 *
 * @param done Optional callback invoked when this poll pass is complete (used
 *             in tests to sequence assertions without sleeping).
 */
function pollFile(state: TailerState, cursors: CursorMap, done?: () => void): void {
  // --- Single-flight guard ---
  // A previous pass is still draining/reading. Skip this tick rather than run a
  // concurrent pass that would race on state.fd/state.offset (close→fd=-1 vs an
  // in-flight read → ERR_OUT_OF_RANGE fd -1). Resolve any test callback so the
  // driver promise never hangs.
  if (state.polling) {
    log('tailer: poll skipped, previous pass in flight', { path: state.path })
    done?.()
    return
  }
  state.polling = true
  const finish = () => {
    state.polling = false
    if (done) done()
  }

  // --- Step 1: ensure fd is open ---
  if (state.fd < 0) {
    open(state.path, 'r', (openErr, fd) => {
      if (openErr) { finish(); return } // file not yet present
      state.fd = fd
      state.fdFileId = fileIdForFd(fd)
      log('tailer: opened file', { path: state.path, fileId: state.fdFileId })
      // Restore cursor from persistent store.
      const saved = cursors[state.path]
      if (saved && saved.fileId === state.fdFileId) {
        // Guard against a cursor persisted BEYOND the current EOF. This happens
        // when the offset drifted past end-of-file (byte-accounting skew, or a
        // shrink/rotation that occurred while the tailer was down). Restoring
        // such an offset verbatim would let the next poll's truncate branch
        // (size < offset) reset to 0 and RE-SHIP the entire file as duplicates
        // — the exact flood that bloats the egress spool. Clamp a past-EOF
        // cursor to the real EOF: resume cleanly and ship only NEW lines.
        fstat(fd, (fstatErr, info) => {
          if (!fstatErr && saved.offset > info.size) {
            log('tailer: cursor past EOF on restore, clamping to EOF', {
              path: state.path,
              saved_offset: saved.offset,
              file_size: info.size,
            })
            state.offset = info.size
          } else {
            state.offset = saved.offset
            log('tailer: resumed at cursor', { path: state.path, offset: state.offset })
          }
          finish()
        })
      } else {
        // No matching cursor — seek to EOF to only ship new lines.
        fstat(fd, (fstatErr, info) => {
          if (!fstatErr) {
            state.offset = info.size
          }
          finish()
        })
      }
    })
    return
  }

  // --- Step 2: fstat the held fd ---
  fstat(state.fd, (fstatErr, fdInfo) => {
    if (fstatErr) {
      // fd became invalid — close and reopen next poll.
      // Guard: stopTailer may have closed the fd and set state.fd=-1 before this
      // callback fired. close(-1) throws ERR_OUT_OF_RANGE, so only close if still valid.
      if (state.fd >= 0) {
        close(state.fd, () => {})
      }
      state.fd = -1
      state.fdFileId = ''
      finish()
      return
    }

    // --- Step 3: detect rename (inode change at path) ---
    stat(state.path, (statErr, pathInfo) => {
      if (statErr) {
        // Path gone — drain held fd then close.
        // Guard: drainFd returns early (done()) when state.fd<0, so the done callback
        // below must also guard before calling close() — stopTailer may have already
        // closed the fd between when drainFd returned and now.
        drainFd(state, fdInfo.size, cursors, () => {
          if (state.fd >= 0) {
            close(state.fd, () => {})
          }
          state.fd = -1
          state.fdFileId = ''
          finish()
        })
        return
      }

      const pathFileId = String(pathInfo.ino ?? 0)
      const fdFileId = String((fdInfo as { ino?: number | bigint }).ino ?? 0)
      const renamed = pathFileId !== '0' && fdFileId !== '0' && pathFileId !== fdFileId

      if (renamed) {
        // Drain orphaned tail from the old fd before following the new file.
        log('tailer: rename detected draining old fd', {
          path: state.path,
          old_id: state.fdFileId,
          new_id: pathFileId,
        })
        // Guard: same shutdown-race as the path-gone branch above — drainFd may
        // return via its fd<0 backstop, after which state.fd may already be -1.
        drainFd(state, fdInfo.size, cursors, () => {
          if (state.fd >= 0) {
            close(state.fd, () => {})
          }
          // Open new file; next poll sets offset from cursor or EOF.
          state.fd = -1
          state.fdFileId = ''
          state.offset = 0
          state.remainder = ''
          delete cursors[state.path]
          finish()
        })
        return
      }

      // --- Step 4: detect truncate-in-place ---
      if (fdInfo.size < state.offset) {
        log('tailer: truncate detected resetting offset', {
          path: state.path,
          old_offset: state.offset,
        })
        state.offset = 0
        state.remainder = ''
      }

      // --- Step 5: drain all new bytes to EOF ---
      // drainFd loops in READ_CHUNK_BYTES increments until state.offset reaches
      // fdInfo.size, saving the cursor after each chunk. A single poll pass
      // therefore fully catches up regardless of how much data arrived since
      // the last poll — no multi-tick lag on log bursts.
      if (fdInfo.size === state.offset) { finish(); return } // nothing new

      // Guard: stopTailer may have closed the fd and set state.fd=-1 while the
      // stat() callback was queued (between fstat completing and here). read(-1)
      // throws ERR_OUT_OF_RANGE, so bail out cleanly instead.
      if (state.fd < 0) { finish(); return }

      drainFd(state, fdInfo.size, cursors, finish)
    })
  })
}

/**
 * Drain the held fd from state.offset to endOffset in READ_CHUNK_BYTES
 * increments, shipping all complete lines and saving the cursor after each
 * chunk. Calls done() when finished.
 *
 * Dual use:
 *   - Normal poll (step 5): drain all new bytes to EOF in a single pass so
 *     log bursts catch up immediately rather than one chunk per poll tick.
 *   - Rename-drain (step 3): ship the orphaned tail bytes written to the old
 *     fd after rotation before closing it and following the new file.
 */
function drainFd(
  state: TailerState,
  endOffset: number,
  cursors: CursorMap,
  done: () => void,
): void {
  // Backstop: never issue a read against a closed fd. The single-flight guard
  // makes a concurrent close impossible, but if a future change reopens the
  // race this prevents the ERR_OUT_OF_RANGE (fd -1) crash. Also guards the
  // recursive re-entry below.
  if (state.fd < 0) {
    done()
    return
  }
  if (state.offset >= endOffset) {
    done()
    return
  }
  const toRead = Math.min(endOffset - state.offset, READ_CHUNK_BYTES)
  const buf = Buffer.allocUnsafe(toRead)
  read(state.fd, buf, 0, toRead, state.offset, (readErr, bytesRead) => {
    if (readErr || bytesRead === 0) {
      done()
      return
    }
    state.offset += bytesRead
    const chunk = buf.subarray(0, bytesRead).toString('utf-8')
    state.remainder = processChunk(chunk, state.remainder)

    // Save cursor after drain so the orphaned bytes are not re-shipped on restart.
    cursors[state.path] = { offset: state.offset, fileId: state.fdFileId }
    saveCursors(cursors)

    if (state.offset < endOffset) {
      drainFd(state, endOffset, cursors, done)
    } else {
      done()
    }
  })
}

function startTailer(path: string, cursors: CursorMap): TailerState {
  const state: TailerState = {
    path,
    offset: 0,
    fd: -1,
    fdFileId: '',
    timer: null,
    stopped: false,
    remainder: '',
    polling: false,
  }

  log('tailer: scheduled', { path })

  if (!state.stopped) {
    state.timer = setInterval(() => {
      if (!state.stopped && !state.polling) pollFile(state, cursors)
    }, TAIL_POLL_INTERVAL_MS)
    if (state.timer && typeof state.timer === 'object' && 'unref' in state.timer) {
      (state.timer as NodeJS.Timeout).unref()
    }
  }

  return state
}

function stopTailer(state: TailerState): void {
  state.stopped = true
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  if (state.fd >= 0) {
    close(state.fd, () => {})
    state.fd = -1
  }
}

// ---------------------------------------------------------------------------
// Module-level tailer management
// ---------------------------------------------------------------------------

let engineTailer: TailerState | null = null
let iosTailer: TailerState | null = null
let telemetryTailer: TailerState | null = null
let tailing = false
let sharedCursors: CursorMap = {}

/**
 * Start tailing engine.jsonl, ios-diagnostic-logs.jsonl, and telemetry.jsonl.
 * Lines are shipped verbatim to the active egress forwarder. Call after
 * configureEgress() so a forwarder is active to receive them.
 *
 * Persistent cursors are loaded from disk at startup and written after each
 * successful ship pass, so restarts resume at the last shipped offset.
 *
 * Idempotent: calling while already tailing is a no-op.
 */
export function startEgressTailers(sources?: string[]): void {
  if (tailing) return
  tailing = true
  sharedCursors = loadCursors()
  // Shipping-responsibility matrix: only tail the sources assigned to the
  // desktop. Undefined preserves the legacy default (tail everything).
  // "desktop" is never tailed — the desktop's own records ship in-process
  // via shipToEgress.
  const wants = (s: string): boolean => !sources || sources.includes(s)
  if (wants('engine')) engineTailer = startTailer(ENGINE_LOG_FILE, sharedCursors)
  if (wants('ios')) iosTailer = startTailer(IOS_LOG_FILE, sharedCursors)
  if (wants('telemetry')) telemetryTailer = startTailer(TELEMETRY_LOG_FILE, sharedCursors)
  log('egress tailers started', {
    engine: wants('engine') ? ENGINE_LOG_FILE : '(not assigned)',
    ios: wants('ios') ? IOS_LOG_FILE : '(not assigned)',
    telemetry: wants('telemetry') ? TELEMETRY_LOG_FILE : '(not assigned)',
  })
}

/**
 * Stop all file tailers. Called on shutdown before closeEgress() so any lines
 * read during the final poll are still in the forwarder buffer for the drain.
 *
 * Saves cursors on stop so the next startup resumes cleanly.
 *
 * Idempotent.
 */
export function stopEgressTailers(): void {
  if (!tailing) return
  tailing = false
  if (engineTailer) { stopTailer(engineTailer); engineTailer = null }
  if (iosTailer) { stopTailer(iosTailer); iosTailer = null }
  if (telemetryTailer) { stopTailer(telemetryTailer); telemetryTailer = null }
  saveCursors(sharedCursors)
  log('egress tailers stopped')
}

/**
 * TEST ONLY. Reset module state between test cases.
 */
export function _resetTailersForTest(): void {
  stopEgressTailers()
  tailing = false
  sharedCursors = {}
}

/**
 * TEST ONLY. Expose shared cursor map for test assertions.
 */
export function _getCursorsForTest(): CursorMap {
  return sharedCursors
}

/**
 * TEST ONLY. Directly update the cursor map (for restart-simulation tests).
 */
export function _setCursorsForTest(cursors: CursorMap): void {
  sharedCursors = cursors
}

/**
 * TEST ONLY. Build a fresh TailerState for use with _pollOnceForTest.
 * Starts at offset 0 with no fd held (the first poll will open the file).
 */
export function _makeStateForTest(path: string): TailerState {
  return {
    path,
    offset: 0,
    fd: -1,
    fdFileId: '',
    timer: null,
    stopped: false,
    remainder: '',
    polling: false,
  }
}

/**
 * TEST ONLY. Drive a single poll pass against `state` and resolve when the
 * pass completes (all async callbacks have returned). This is the correct
 * driver for integration tests: it exercises the real tailer machinery against
 * real file descriptors without any timers or module-level singletons.
 */
export function _pollOnceForTest(state: TailerState, cursors: CursorMap): Promise<void> {
  return new Promise<void>((resolve) => {
    pollFile(state, cursors, resolve)
  })
}

/**
 * TEST ONLY. Close the fd held in state (if any) without running a full stop.
 * Use in test afterEach to avoid fd leaks.
 */
export function _closeFdForTest(state: TailerState): void {
  if (state.fd >= 0) {
    close(state.fd, () => {})
    state.fd = -1
  }
}

// Re-export CursorEntry for tests.
export type { CursorEntry }
