// Main-thread stall watchdog.
//
// Electron's main process is single-threaded JavaScript. When a synchronous
// loop pegs it, NOTHING on the main thread runs — not IPC, not timers, not the
// logger's own buffered flush (logger.ts flushes on a setInterval that also
// lives on the main thread). So the exact moment we most need a diagnostic is
// the moment the main-process logger goes blind. A machine-freezing wedge in
// this app left us with a log that simply cuts off mid-line, telling us nothing
// about what the thread was doing for the hours it spun.
//
// This watchdog observes the main thread from OUTSIDE it. A worker thread shares
// a SharedArrayBuffer with the main thread and:
//
//   - reads a HEARTBEAT the main thread stamps on a timer. When the main thread
//     wedges, its timer stops firing and the heartbeat goes stale — that is the
//     detection signal, and it works precisely because the worker runs on its
//     own OS thread and keeps polling while the main JS thread is frozen.
//
//   - reads an ACTIVITY BREADCRUMB (a subsystem code plus a monotonic counter)
//     that the main thread updates INLINE at hot-path entry points via mark().
//     Because the SharedArrayBuffer is shared memory, the worker sees the
//     breadcrumb advance live even while the main JS thread is inside a
//     synchronous loop that never yields. A counter that keeps climbing under a
//     given subsystem code names the exact loop that is spinning; a counter that
//     is flat while the heartbeat is stale means the thread is stuck in a
//     synchronous call that does not pass through an instrumented breadcrumb
//     (still telling us the last subsystem it entered).
//
// The worker writes the stall record itself with appendFileSync, so the record
// survives the very wedge it is reporting — unlike the main-thread logger.
//
// No inspector port is opened (no attack-surface expansion), and the worker runs
// from an inline eval source so there is no separate bundle entry to wire into
// electron-vite.

import { Worker } from 'worker_threads'
import { appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOG_FILE = join(homedir(), '.ion', 'desktop.jsonl')

/**
 * How often the main thread stamps the heartbeat. Short enough that a genuine
 * wedge is detected within a couple of poll cycles, long enough to be free.
 */
const BEAT_INTERVAL_MS = 1000

/**
 * How often the worker checks the heartbeat and breadcrumb. Independent of the
 * main thread — runs on the worker's own thread.
 */
const POLL_INTERVAL_MS = 1000

/**
 * The heartbeat must be older than this for the worker to declare the main
 * thread stalled. Set well above BEAT_INTERVAL_MS so a single delayed tick (GC
 * pause, a slow-but-legitimate synchronous operation) does not false-positive;
 * only a genuine multi-second wedge trips it.
 */
const STALE_THRESHOLD_MS = 5000

/**
 * SharedArrayBuffer layout. A BigInt64 heartbeat at offset 0 (Date.now() in ms
 * exceeds Int32 range, so it needs 64 bits), then an Int32 activity block at
 * offset 8: [0] = activity code, [1] = monotonic activity counter.
 */
const SAB_BYTES = 64
const HEARTBEAT_OFFSET = 0
const ACTIVITY_OFFSET = 8

/**
 * Activity codes for the breadcrumb. The order here is the source of truth for
 * the ACTIVITY_NAMES table the worker uses to label its records; keep the two in
 * sync. Add new codes at the end so existing numeric values never shift.
 */
export const Activity = {
  Idle: 0,
  EngineEvent: 1,
  RelaySend: 2,
  Retransmit: 3,
  RendererForward: 4,
  Snapshot: 5,
  // Fine-grained relay-send sub-stages. A stall with counter frozen and
  // spinning=false means the main thread is stuck in ONE uninstrumented
  // synchronous call. The generic RelaySend (marked once per drain iteration,
  // before sendToAll) could not distinguish WHICH synchronous step inside
  // sendToAll/buildDeviceFrame hung. These sub-stages are marked immediately
  // before each candidate op so the next wedge names it exactly:
  //   relay_stringify → JSON.stringify(event)
  //   relay_compress  → deflateRawSync(plaintext)  (per device)
  //   relay_encrypt   → AES-256-GCM encrypt        (per device)
  //   relay_record    → retransmit buffer record   (per device)
  //   relay_deliver   → ws.send to the transport    (per device)
  RelayStringify: 6,
  RelayCompress: 7,
  RelayEncrypt: 8,
  RelayRecord: 9,
  RelayDeliver: 10,
} as const

export type ActivityCode = (typeof Activity)[keyof typeof Activity]

/**
 * Human-readable labels, indexed by activity code. Mirrors Activity above.
 * Exported for the enum↔names sync invariant test — if these drift, the worker
 * labels stall records with the wrong activity, misdirecting a wedge diagnosis.
 */
export const ACTIVITY_NAMES = [
  'idle', 'engine_event', 'relay_send', 'retransmit', 'renderer_forward', 'snapshot',
  'relay_stringify', 'relay_compress', 'relay_encrypt', 'relay_record', 'relay_deliver',
]

/**
 * The stall-decision function. Extracted as a pure function so it can be unit
 * tested directly AND embedded verbatim into the worker source (via toString),
 * giving one source of truth for the detection logic instead of a drift-prone
 * copy. Given the current clock, the last heartbeat, and the previous poll's
 * counter, it decides whether the main thread is stalled and which transition
 * (onset / ongoing / recovery / none) the worker should report.
 */
export function evaluateStall(s: {
  nowMs: number
  beatMs: number
  staleMs: number
  counter: number
  prevCounter: number
  wasStalled: boolean
}): { isStalled: boolean; transition: 'onset' | 'ongoing' | 'recovery' | 'none'; stallMs: number; counterDelta: number } {
  const stallMs = s.nowMs - s.beatMs
  const isStalled = stallMs >= s.staleMs
  const counterDelta = s.counter - s.prevCounter
  let transition: 'onset' | 'ongoing' | 'recovery' | 'none' = 'none'
  if (isStalled && !s.wasStalled) transition = 'onset'
  else if (isStalled && s.wasStalled) transition = 'ongoing'
  else if (!isStalled && s.wasStalled) transition = 'recovery'
  return { isStalled, transition, stallMs, counterDelta }
}

/**
 * The worker's poll loop. Runs in the worker global scope (has require,
 * workerData). References evaluateStall, which is prepended to the worker source
 * as a top-level declaration. Kept as a named function so it can be stringified
 * into the eval source; it is never called on the main thread.
 */
function watchdogLoop(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { workerData } = require('worker_threads')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs')
  const { sab, logFile, staleMs, pollMs, heartbeatOffset, activityOffset, activityNames } = workerData
  const hb = new BigInt64Array(sab, heartbeatOffset, 1)
  const act = new Int32Array(sab, activityOffset, 2)
  let wasStalled = false
  let prevCounter = Atomics.load(act, 1)

  setInterval(() => {
    try {
      const nowMs = Date.now()
      const beatMs = Number(Atomics.load(hb, 0))
      const code = Atomics.load(act, 0)
      const counter = Atomics.load(act, 1)
      // evaluateStall is in scope: prepended to the worker source.
      // eslint-disable-next-line no-undef
      const r = evaluateStall({ nowMs, beatMs, staleMs, counter, prevCounter, wasStalled })
      prevCounter = counter
      wasStalled = r.isStalled
      if (r.transition === 'none') return
      const level = r.transition === 'recovery' ? 'WARN' : 'ERROR'
      const msg =
        r.transition === 'recovery'
          ? 'main thread recovered from stall'
          : r.transition === 'onset'
            ? 'main thread STALL detected'
            : 'main thread still stalled'
      const rec = {
        ts: new Date().toISOString().replace('Z', '') + '000000Z',
        level,
        component: 'desktop',
        tag: 'watchdog',
        msg,
        fields: {
          stall_ms: r.stallMs,
          activity_code: code,
          activity: activityNames[code] ?? String(code),
          activity_counter: counter,
          // The decisive signal: a positive delta while stalled means the main
          // thread is actively spinning through this subsystem's breadcrumb (a
          // hot loop); a zero delta means it is stuck in a synchronous call that
          // does not reach an instrumented breadcrumb.
          counter_delta_since_poll: r.counterDelta,
          spinning: r.counterDelta > 0,
        },
      }
      fs.appendFileSync(logFile, JSON.stringify(rec) + '\n')
    } catch (err) {
      try {
        fs.appendFileSync(
          workerData.logFile,
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'ERROR',
            component: 'desktop',
            tag: 'watchdog',
            msg: 'watchdog loop error',
            fields: { error: err instanceof Error ? err.message : String(err) },
          }) + '\n',
        )
      } catch {
        // Nothing more we can do; never let the watchdog crash the worker.
      }
    }
  }, pollMs)
}

let worker: Worker | null = null
let beatTimer: ReturnType<typeof setInterval> | null = null
let heartbeat: BigInt64Array | null = null
let activity: Int32Array | null = null

/**
 * Start the watchdog. Idempotent: a second call is a no-op. Creates the shared
 * buffer, spawns the worker from an inline eval source, and starts the main-side
 * heartbeat. Both the worker and the beat timer are unref'd so they never keep
 * the process alive on their own; stopWatchdog tears them down on quit.
 */
export function startWatchdog(): void {
  if (worker) return
  const sab = new SharedArrayBuffer(SAB_BYTES)
  heartbeat = new BigInt64Array(sab, HEARTBEAT_OFFSET, 1)
  activity = new Int32Array(sab, ACTIVITY_OFFSET, 2)
  Atomics.store(heartbeat, 0, BigInt(Date.now()))
  Atomics.store(activity, 0, Activity.Idle)
  Atomics.store(activity, 1, 0)

  // One source of truth for the detection logic: prepend evaluateStall's own
  // text so the worker calls the exact function this module unit-tests.
  const workerSource = `${evaluateStall.toString()}\n(${watchdogLoop.toString()})()`

  try {
    worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        sab,
        logFile: LOG_FILE,
        staleMs: STALE_THRESHOLD_MS,
        pollMs: POLL_INTERVAL_MS,
        heartbeatOffset: HEARTBEAT_OFFSET,
        activityOffset: ACTIVITY_OFFSET,
        activityNames: ACTIVITY_NAMES,
      },
    })
    worker.unref()
    worker.on('error', (err) => {
      // The watchdog failing must never take the app down. Record and continue
      // without a watchdog rather than propagating.
      try {
        appendFileSync(
          LOG_FILE,
          JSON.stringify({
            ts: new Date().toISOString().replace('Z', '') + '000000Z',
            level: 'ERROR',
            component: 'desktop',
            tag: 'watchdog',
            msg: 'watchdog worker error',
            fields: { error: err.message },
          }) + '\n',
        )
      } catch {
        // best effort
      }
    })
  } catch {
    worker = null
    heartbeat = null
    activity = null
    return
  }

  beatTimer = setInterval(() => {
    if (heartbeat) Atomics.store(heartbeat, 0, BigInt(Date.now()))
  }, BEAT_INTERVAL_MS)
  if (beatTimer && typeof beatTimer === 'object' && 'unref' in beatTimer) beatTimer.unref()
}

/**
 * Record that the main thread has entered a hot-path subsystem. Writes the
 * activity code and bumps the monotonic counter — two Atomics ops, cheap enough
 * to sit inline in per-event hot paths. A no-op when the watchdog is not
 * running, so call sites and tests need no guard.
 */
export function mark(code: ActivityCode): void {
  if (!activity) return
  Atomics.store(activity, 0, code)
  Atomics.add(activity, 1, 1)
}

/** Stop the watchdog and release its worker. Called on app quit. */
export function stopWatchdog(): void {
  if (beatTimer) {
    clearInterval(beatTimer)
    beatTimer = null
  }
  if (worker) {
    void worker.terminate()
    worker = null
  }
  heartbeat = null
  activity = null
}
