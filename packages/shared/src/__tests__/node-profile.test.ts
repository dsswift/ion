/**
 * `captureNodeProfile` writes a CPU profile or a heap snapshot of this very
 * process under `<dir>/profiles/`, in the formats Chrome DevTools opens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { captureNodeProfile, clampProfileSeconds, DEFAULT_CPU_PROFILE_SECONDS, MAX_CPU_PROFILE_SECONDS, profilesDir } from '../node-profile'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-node-profile-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('captureNodeProfile', () => {
  it('samples the CPU for the asked seconds and writes a .cpuprofile with nodes and samples', async () => {
    const result = await captureNodeProfile({ kind: 'cpu', seconds: 1, dir, processName: 'server' })
    expect(result.kind).toBe('cpu')
    expect(result.path.startsWith(profilesDir(dir))).toBe(true)
    expect(result.path).toMatch(/server-cpu-.*\.cpuprofile$/)
    expect(result.durationMs).toBeGreaterThanOrEqual(900)
    const profile = JSON.parse(readFileSync(result.path, 'utf-8')) as { nodes: unknown[]; samples: unknown[] }
    expect(Array.isArray(profile.nodes)).toBe(true)
    expect(profile.nodes.length).toBeGreaterThan(0)
    expect(result.bytes).toBe(statSync(result.path).size)
  }, 15_000)

  it('streams a heap snapshot to a .heapsnapshot file', async () => {
    const result = await captureNodeProfile({ kind: 'heap', dir, processName: 'server' })
    expect(result.kind).toBe('heap')
    expect(result.path).toMatch(/server-heap-.*\.heapsnapshot$/)
    expect(result.bytes).toBeGreaterThan(1_000)
    expect(statSync(result.path).size).toBe(result.bytes)
    const fd = openSync(result.path, 'r')
    const head = Buffer.alloc(32)
    readSync(fd, head, 0, 32, 0)
    closeSync(fd)
    expect(head.toString('utf-8')).toMatch(/^\{"snapshot":/)
  }, 60_000)

  it('clamps the CPU sampling time', () => {
    expect(clampProfileSeconds(undefined)).toBe(DEFAULT_CPU_PROFILE_SECONDS)
    expect(clampProfileSeconds(0)).toBe(1)
    expect(clampProfileSeconds(2.6)).toBe(3)
    expect(clampProfileSeconds(10_000)).toBe(MAX_CPU_PROFILE_SECONDS)
    expect(clampProfileSeconds('5')).toBe(DEFAULT_CPU_PROFILE_SECONDS)
  })
})
