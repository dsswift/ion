/**
 * Transport crypto worker — worker_threads entry.
 *
 * Runs the outbound stringify→DEFLATE→AES-GCM pipeline off the Electron main
 * thread. The main thread posts jobs (plaintext + per-device seq allocations);
 * this worker builds the encrypted wire frames via the shared pure pipeline
 * (transport-frame-pipeline.ts) and posts them back. postMessage is FIFO in
 * both directions, so reply order always matches job-post order — the host
 * relies on this for the per-device seq-ordering invariant.
 *
 * PURITY: this file and everything it imports must be loadable outside
 * Electron (worker_threads has no Electron APIs, and the main-process logger
 * must not be written from two threads). Errors are reported back to the host,
 * which logs them on the main thread.
 *
 * Bundled as a second rollup input in electron.vite.config.ts, emitted next to
 * the main bundle so the host can spawn it via join(__dirname, ...).
 */

import { parentPort } from 'worker_threads'
import { buildFramesForEvent } from './transport-frame-pipeline'
import type { CryptoWorkerRequest, CryptoWorkerResponse } from './transport-send-worker-host'

const secrets = new Map<string, Buffer>()

if (!parentPort) {
  throw new Error('transport-crypto-worker must run inside a worker_threads Worker')
}

parentPort.on('message', (msg: CryptoWorkerRequest) => {
  if (msg.type === 'secrets') {
    secrets.clear()
    for (const { deviceId, key } of msg.secrets) {
      // Structured clone delivers the key bytes as a Uint8Array; rewrap.
      secrets.set(deviceId, Buffer.from(key))
    }
    return
  }
  // type === 'job'
  let response: CryptoWorkerResponse
  try {
    const { wireBytes, results } = buildFramesForEvent(msg.plaintext, msg.devices, secrets, msg.opts)
    response = { type: 'result', jobId: msg.jobId, wireBytes, results }
  } catch (err) {
    // A pipeline throw (not a per-device encrypt failure — those come back as
    // per-device errors) fails the whole job; the host replays it via the
    // synchronous path with the original seqs.
    response = { type: 'result', jobId: msg.jobId, wireBytes: 0, results: [], jobError: (err as Error).message }
  }
  parentPort!.postMessage(response)
})
