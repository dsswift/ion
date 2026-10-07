/**
 * A CPU profile or heap snapshot of the Studio renderer, driven from main
 * through `webContents.debugger` (the Chrome DevTools protocol's Profiler
 * and HeapProfiler domains), written under `outDir`.
 */
import type { WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProfileKind, ProfileProcess } from '../../shared/desktop-ipc'

/** `desktop-<process>-<kind>-<ts>.cpuprofile` (or `.heapsnapshot`), the name a renderer capture gets; main's captures follow the same shape. */
export function profileFileName(process: ProfileProcess, kind: ProfileKind, atMs: number): string {
  const ts = new Date(atMs).toISOString().replace(/[:.]/g, '-')
  return `desktop-${process}-${kind}-${ts}.${kind === 'cpu' ? 'cpuprofile' : 'heapsnapshot'}`
}

/** The slice of `webContents.debugger` this module drives, so a test can stand one in. */
export interface DebuggerLike {
  isAttached(): boolean
  attach(version?: string): void
  detach(): void
  sendCommand(method: string, params?: object): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Captures a profile of the renderer behind `dbg` into `outDir` and returns the file's path. */
export async function captureRendererProfile(dbg: DebuggerLike, kind: ProfileKind, seconds: number, outDir: string, atMs: number = Date.now()): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, profileFileName('renderer', kind, atMs))
  const attachedHere = !dbg.isAttached()
  if (attachedHere) dbg.attach('1.3')
  try {
    if (kind === 'cpu') {
      await dbg.sendCommand('Profiler.enable')
      await dbg.sendCommand('Profiler.start')
      await wait(Math.max(0, seconds) * 1000)
      const { profile } = (await dbg.sendCommand('Profiler.stop')) as { profile: unknown }
      writeFileSync(path, JSON.stringify(profile))
      await dbg.sendCommand('Profiler.disable')
    } else {
      const chunks: string[] = []
      const onMessage = (_event: unknown, method: string, params: unknown): void => {
        if (method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push((params as { chunk: string }).chunk)
      }
      dbg.on('message', onMessage)
      try {
        await dbg.sendCommand('HeapProfiler.enable')
        await dbg.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
        await dbg.sendCommand('HeapProfiler.disable')
      } finally {
        dbg.removeListener('message', onMessage)
      }
      writeFileSync(path, chunks.join(''))
    }
  } finally {
    if (attachedHere) dbg.detach()
  }
  return path
}

/** The debugger of a live window's contents, or null when there is no window to profile. */
export function rendererDebugger(contents: WebContents | null | undefined): DebuggerLike | null {
  if (!contents || contents.isDestroyed()) return null
  return contents.debugger as unknown as DebuggerLike
}
