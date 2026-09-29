/**
 * The watchdog worker is an eval'd string read back from the bundled module,
 * so it has to run in a real Worker, not just parse.
 */
import { describe, expect, it, vi } from 'vitest'
import { Worker } from 'worker_threads'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildWorkerSource } from './watchdog'

describe('watchdog worker source', () => {
  it('carries no bundler require shim', () => {
    expect(buildWorkerSource()).not.toMatch(/__require/)
    // Under any bundler (vitest's esbuild transform included) the call reads `require(...)`, never a shim.
    expect(buildWorkerSource()).toMatch(/[^_\w]require\(["']worker_threads["']\)/)
  })

  it('files a stall against the caller\'s file, component and pid', async () => {
    // The worker used to hard-code desktop.jsonl and component 'desktop', so a
    // server stall was filed against the desktop and a headless server created a
    // desktop.jsonl next to no desktop at all. Both now come from the caller,
    // and pid is what tells two watchdog-running processes apart.
    const dir = mkdtempSync(join(tmpdir(), 'ion-watchdog-'))
    const logFile = join(dir, 'server.jsonl')
    const sab = new SharedArrayBuffer(64)
    // Heartbeat left at 0: the worker reads it as an ancient beat and reports a
    // stall on its first poll, with no need to wait out a real threshold.
    const worker = new Worker(buildWorkerSource(), {
      eval: true,
      workerData: {
        sab,
        logFile,
        component: 'server',
        hostPid: 4242,
        staleMs: 5_000,
        pollMs: 10,
        heartbeatOffset: 0,
        activityOffset: 8,
        activityNames: ['idle'],
      },
    })
    try {
      await vi.waitFor(() => expect(existsSync(logFile)).toBe(true), { timeout: 2_000, interval: 10 })
      const rec = JSON.parse(readFileSync(logFile, 'utf-8').trim().split('\n')[0]) as {
        component: string
        tag: string
        level: string
        ts: string
        fields: { pid: number; stall_ms: number }
      }
      expect(rec.component).toBe('server')
      expect(rec.tag).toBe('watchdog')
      expect(rec.level).toBe('ERROR')
      expect(rec.fields.pid).toBe(4242)
      expect(rec.fields.stall_ms).toBeGreaterThan(0)
      // Canonical schema: RFC3339 padded to nanoseconds, never plain millis.
      expect(rec.ts).toMatch(/\.\d{9}Z$/)
    } finally {
      await worker.terminate()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('boots in a real worker and answers pause/resume without an error event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-watchdog-'))
    const sab = new SharedArrayBuffer(64)
    const worker = new Worker(buildWorkerSource(), {
      eval: true,
      workerData: { sab, logFile: join(dir, 'log.jsonl'), component: 'server', hostPid: process.pid, staleMs: 60_000, pollMs: 10, heartbeatOffset: 0, activityOffset: 8, activityNames: ['idle'] },
    })
    const errors: string[] = []
    worker.on('error', (err) => errors.push(String(err)))
    try {
      worker.postMessage({ type: 'pause' })
      worker.postMessage({ type: 'resume' })
      await new Promise((r) => setTimeout(r, 60))
      expect(errors).toEqual([])
    } finally {
      await worker.terminate()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
