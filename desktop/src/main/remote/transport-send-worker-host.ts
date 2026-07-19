/**
 * Main-thread host for the transport crypto worker.
 *
 * Owns the worker lifecycle (spawn on transport start, terminate on stop) and
 * the job protocol. The division of labor (see the plan in transport-send.ts):
 *
 *   MAIN THREAD  — lane queue + drain selection, per-device seq allocation
 *                  (at job-post time, in drain order), wire-frame cap gate,
 *                  retransmit.record, deliverFrame, watchdog breadcrumbs,
 *                  all logging.
 *   WORKER       — JSON.stringify is done on main (the event object cannot be
 *                  structured-cloned cheaply and the plaintext is needed for
 *                  the early size gate anyway); the worker does DEFLATE +
 *                  per-device AES-256-GCM — the measured wedge candidates
 *                  (watchdog activities RelayCompress / RelayEncrypt).
 *
 * ORDERING INVARIANT: jobs are posted in drain order with seqs pre-allocated
 * at post time; postMessage is FIFO in both directions; replies are processed
 * in arrival order. Therefore retransmit.record and deliverFrame run in
 * strictly increasing per-device seq order — identical to the synchronous
 * path. This invariant is pinned by transport-send-worker-host.test.ts.
 *
 * RESILIENCE: on worker error/exit, every unanswered job is replayed through
 * the synchronous pipeline IN ORDER using its original pre-allocated seqs (no
 * seq is ever re-allocated, so the wire stream stays contiguous), the worker
 * is respawned once, and if the respawn also dies the host stays in
 * synchronous mode for the life of the transport instance. The synchronous
 * sendToAll path in transport-send.ts remains fully intact as that fallback.
 */

import { Worker } from 'worker_threads'
import { existsSync } from 'fs'
import { join } from 'path'
import { log as _log, error as _error } from '../logger'
import { mark, Activity } from '../watchdog'
import { frameLengthWithinWireCap } from './transport-send'
import { buildFramesForEvent, type PipelineDevice, type PipelineOpts, type PipelineResult } from './transport-frame-pipeline'
import type { WireMessage } from './protocol'
import type { RetransmitBuffer } from './retransmit-buffer'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('crypto-worker-host', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('crypto-worker-host', msg, fields)
}

/** Messages main → worker. */
export type CryptoWorkerRequest =
  | { type: 'secrets'; secrets: { deviceId: string; key: Uint8Array }[] }
  | { type: 'job'; jobId: number; plaintext: string; devices: PipelineDevice[]; opts: PipelineOpts }

/** Messages worker → main. */
export interface CryptoWorkerResponse {
  type: 'result'
  jobId: number
  wireBytes: number
  results: PipelineResult[]
  /** Set when the whole job threw (host replays it via the sync path). */
  jobError?: string
}

/** What the host needs from the transport to finish a job on reply. */
export interface CryptoHostSink {
  retransmit: RetransmitBuffer
  deliverFrame: (deviceId: string, frame: WireMessage) => boolean
  /** Per-frame telemetry hook (the sync path logs this in buildDeviceFrame). */
  onFrameBuilt?: (deviceId: string, seq: number, eventType: string, wireBytes: number, enqueuedAt?: number) => void
}

interface PendingJob {
  jobId: number
  plaintext: string
  eventType: string
  devices: PipelineDevice[]
  opts: PipelineOpts
  enqueuedAt?: number
}

export class TransportCryptoHost {
  private worker: Worker | null = null
  private nextJobId = 1
  /** Jobs posted and not yet answered, in post (== reply) order. */
  private pending: PendingJob[] = []
  private respawned = false
  /** Permanently degraded to the synchronous path after a failed respawn. */
  private syncOnly = false
  private lastSecrets: { deviceId: string; key: Uint8Array }[] = []

  constructor(private sink: CryptoHostSink, private workerPath?: string) {}

  /** True when jobs will be posted to a live worker. */
  get usingWorker(): boolean {
    return this.worker !== null && !this.syncOnly
  }

  /** Number of posted-but-unanswered jobs (test/telemetry seam). */
  get pendingCount(): number {
    return this.pending.length
  }

  start(): void {
    if (this.syncOnly || this.worker) return
    const path = this.workerPath ?? join(__dirname, 'transport-crypto-worker.js')
    // Missing artifact (unbundled test env, broken build) is detected
    // synchronously: new Worker() reports a bad path via an ASYNC 'error'
    // event, which would leave a window where usingWorker is true but no
    // frame will ever come back. Degrade to sync mode up front instead.
    if (!existsSync(path)) {
      log('crypto worker artifact not found; using synchronous pipeline', { path })
      this.worker = null
      this.syncOnly = true
      return
    }
    try {
      this.worker = new Worker(path)
    } catch (err) {
      // Startup failure (missing artifact, bad path): stay synchronous forever.
      error('crypto worker failed to start; using synchronous pipeline', { error: (err as Error).message, path })
      this.worker = null
      this.syncOnly = true
      return
    }
    this.worker.unref()
    this.worker.on('message', (msg: CryptoWorkerResponse) => this._onReply(msg))
    this.worker.on('error', (err) => this._onWorkerDeath(`error: ${err.message}`))
    this.worker.on('exit', (code) => {
      // Deliberate terminate() in stop() nulls this.worker first.
      if (this.worker) this._onWorkerDeath(`exit code ${code}`)
    })
    if (this.lastSecrets.length > 0) {
      this.worker.postMessage({ type: 'secrets', secrets: this.lastSecrets } satisfies CryptoWorkerRequest)
    }
    log('crypto worker started', { path })
  }

  async stop(): Promise<void> {
    const w = this.worker
    this.worker = null
    // Anything still unanswered is finished synchronously so no frame is lost.
    this._replayPendingSync('transport stop')
    if (w) await w.terminate()
  }

  /** Push the full secret set to the worker (on start, pair, unpair). */
  setSecrets(deviceSecrets: Map<string, Buffer>): void {
    this.lastSecrets = [...deviceSecrets.entries()].map(([deviceId, key]) => ({ deviceId, key: new Uint8Array(key) }))
    this.worker?.postMessage({ type: 'secrets', secrets: this.lastSecrets } satisfies CryptoWorkerRequest)
  }

  /**
   * Process one event through the worker. Returns false when the host is in
   * sync mode (caller runs the synchronous path instead). Seqs in `devices`
   * were allocated by the caller in drain order — the invariant anchor.
   */
  submit(plaintext: string, eventType: string, devices: PipelineDevice[], opts: PipelineOpts, enqueuedAt?: number): boolean {
    if (!this.usingWorker) return false
    const job: PendingJob = { jobId: this.nextJobId++, plaintext, eventType, devices, opts, enqueuedAt }
    this.pending.push(job)
    this.worker!.postMessage({ type: 'job', jobId: job.jobId, plaintext, devices: job.devices, opts } satisfies CryptoWorkerRequest)
    return true
  }

  /** Apply one job's built frames: cap gate → retransmit.record → deliver. */
  private _applyResults(job: PendingJob, wireBytes: number, results: PipelineResult[]): void {
    for (const r of results) {
      if (!r.frame) {
        error('crypto worker: frame build failed for device', { device_id: r.deviceId, event_type: job.eventType, error: r.error })
        continue
      }
      // Same authoritative wire-frame cap as the sync path, using the exact
      // serialized length the worker measured.
      if (!frameLengthWithinWireCap(r.serializedLength, job.eventType, r.deviceId)) continue
      this.sink.onFrameBuilt?.(r.deviceId, r.seq, job.eventType, wireBytes, job.enqueuedAt)
      mark(Activity.RelayRecord)
      this.sink.retransmit.record(r.deviceId, r.frame)
      mark(Activity.RelayDeliver)
      this.sink.deliverFrame(r.deviceId, r.frame)
    }
  }

  private _onReply(msg: CryptoWorkerResponse): void {
    // postMessage is FIFO: the reply always matches the head of pending.
    const idx = this.pending.findIndex((j) => j.jobId === msg.jobId)
    if (idx === -1) {
      // Already replayed synchronously (worker death race) — drop the late reply.
      log('crypto worker: late reply for already-settled job, ignoring', { job_id: msg.jobId })
      return
    }
    const job = this.pending[idx]
    this.pending.splice(idx, 1)
    if (msg.jobError) {
      error('crypto worker: job failed, replaying synchronously', { job_id: msg.jobId, error: msg.jobError })
      this._runJobSync(job)
      return
    }
    this._applyResults(job, msg.wireBytes, msg.results)
  }

  /** Run one job through the shared pure pipeline on the main thread. */
  private _runJobSync(job: PendingJob): void {
    mark(Activity.RelayCompress)
    const secrets = new Map(this.lastSecrets.map((s) => [s.deviceId, Buffer.from(s.key)]))
    const { wireBytes, results } = buildFramesForEvent(job.plaintext, job.devices, secrets, job.opts)
    this._applyResults(job, wireBytes, results)
  }

  /** Replay every unanswered job through the sync pipeline, in post order. */
  private _replayPendingSync(reason: string): void {
    if (this.pending.length === 0) return
    log('crypto worker: replaying pending jobs synchronously', { count: this.pending.length, reason })
    const jobs = this.pending
    this.pending = []
    for (const job of jobs) this._runJobSync(job)
  }

  private _onWorkerDeath(reason: string): void {
    error('crypto worker died', { reason, pending: this.pending.length, respawned_before: this.respawned })
    this.worker = null
    // Original seqs are preserved in the pending jobs — the wire stream stays
    // contiguous even across the death.
    this._replayPendingSync(reason)
    if (this.respawned) {
      this.syncOnly = true
      error('crypto worker died twice; staying on synchronous pipeline for this transport instance')
      return
    }
    this.respawned = true
    this.start()
  }
}
