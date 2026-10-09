/**
 * node-profile — a CPU profile or heap snapshot of this Node process,
 * written through the inspector protocol (`node:inspector`), with no
 * debugger attached and no restart.
 *
 * Shared by the Ion server (`profile.capture`, a developer-surface action)
 * and Electron main, which profiles itself the same way. A capture is a
 * file under `<dir>/profiles/`: `server-cpu-<ts>.cpuprofile` opens in Chrome
 * DevTools' Performance panel and `server-heap-<ts>.heapsnapshot` in its
 * Memory panel. The caller decides who may ask for one; this module only
 * captures.
 */
import { Session } from 'node:inspector'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type NodeProfileKind = 'cpu' | 'heap'

export interface NodeProfileRequest {
  kind: NodeProfileKind
  /** CPU only: how long to sample. Clamped to `[1, MAX_CPU_PROFILE_SECONDS]`. */
  seconds?: number
  /** The data directory; the capture lands in its `profiles/` folder. */
  dir: string
  /** Names the process in the file name: `server`, `desktop`. */
  processName: string
  /** Clock override (test use). */
  now?: () => number
}

export interface NodeProfileResult {
  kind: NodeProfileKind
  path: string
  /** Wall-clock milliseconds the capture took. */
  durationMs: number
  /** Bytes written. */
  bytes: number
}

export const DEFAULT_CPU_PROFILE_SECONDS = 10
export const MAX_CPU_PROFILE_SECONDS = 120

/** The folder captures land in. */
export function profilesDir(dir: string): string {
  return join(dir, 'profiles')
}

/** The seconds a CPU capture samples for, from what the caller asked. */
export function clampProfileSeconds(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return DEFAULT_CPU_PROFILE_SECONDS
  return Math.min(MAX_CPU_PROFILE_SECONDS, Math.max(1, Math.round(seconds)))
}

/** Promisified `Session.post`. */
function post<T = unknown>(session: Session, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (err: Error | null, result: unknown) => {
      if (err) reject(err)
      else resolve(result as T)
    })
  })
}

function fileStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

async function captureCpu(session: Session, seconds: number): Promise<string> {
  await post(session, 'Profiler.enable')
  await post(session, 'Profiler.start')
  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000))
  const { profile } = await post<{ profile: unknown }>(session, 'Profiler.stop')
  await post(session, 'Profiler.disable')
  return JSON.stringify(profile)
}

/**
 * Streams the snapshot's chunks to `path` as they arrive, since a heap
 * snapshot is routinely hundreds of megabytes and never fits a string.
 */
async function captureHeap(session: Session, path: string): Promise<number> {
  const out = createWriteStream(path)
  let bytes = 0
  const drained: Array<Promise<void>> = []
  session.on('HeapProfiler.addHeapSnapshotChunk', (message: { params: { chunk: string } }) => {
    const chunk = message.params.chunk
    bytes += Buffer.byteLength(chunk)
    if (!out.write(chunk)) drained.push(new Promise<void>((resolve) => out.once('drain', resolve)))
  })
  await post(session, 'HeapProfiler.enable')
  await post(session, 'HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  await post(session, 'HeapProfiler.disable')
  await Promise.all(drained)
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject)
    out.end(() => resolve())
  })
  return bytes
}

/** Captures one profile of this process and writes it under `profilesDir(dir)`. */
export async function captureNodeProfile(request: NodeProfileRequest): Promise<NodeProfileResult> {
  const now = request.now ?? Date.now
  const startedAt = now()
  const folder = profilesDir(request.dir)
  mkdirSync(folder, { recursive: true })
  const stamp = fileStamp(startedAt)
  const session = new Session()
  session.connect()
  try {
    if (request.kind === 'cpu') {
      const path = join(folder, `${request.processName}-cpu-${stamp}.cpuprofile`)
      const body = await captureCpu(session, clampProfileSeconds(request.seconds))
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(path)
        out.once('error', reject)
        out.end(body, () => resolve())
      })
      return { kind: 'cpu', path, durationMs: now() - startedAt, bytes: Buffer.byteLength(body) }
    }
    const path = join(folder, `${request.processName}-heap-${stamp}.heapsnapshot`)
    const bytes = await captureHeap(session, path)
    return { kind: 'heap', path, durationMs: now() - startedAt, bytes }
  } finally {
    session.disconnect()
  }
}
