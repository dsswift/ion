/**
 * Cold-start bench identity must be answerable before renderer caches exist.
 * These tests drive real bench IPC against persisted workspace records and pin
 * separator-safe containment, which prevents a sibling prefix from borrowing
 * another bench's repo identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

let home: string
let repo: string
let bench: string
let resolvePath: (event: unknown, args: { directory: string }) => unknown

beforeEach(async () => {
  handlers.clear()
  home = mkdtempSync(join(tmpdir(), 'ion-bench-path-'))
  process.env.HOME = home
  repo = join(home, 'repo')
  bench = join(home, 'integration', 'project-main')
  mkdirSync(join(home, '.ion'), { recursive: true })
  mkdirSync(join(bench, 'desktop'), { recursive: true })
  writeFileSync(join(home, '.ion', 'integration-workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: [{
      repoPath: repo,
      sourceBranch: 'main',
      benchPath: bench,
      benchBranch: 'ion/bench/main',
      members: [],
      baseSha: 'base',
      lastBuiltAt: 1,
    }],
  }))

  const { registerBenchIpc } = await import('../ipc/bench')
  const { IPC } = await import('../../shared/types')
  registerBenchIpc()
  resolvePath = handlers.get(IPC.BENCH_RESOLVE_PATH) as typeof resolvePath
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.resetModules()
})

function resolve(directory: string): { workspace: { repoPath: string; sourceBranch: string } | null } {
  return resolvePath({}, { directory }) as ReturnType<typeof resolve>
}

describe('bench path resolver IPC', () => {
  it('resolves the exact bench root to its persisted workspace', () => {
    expect(resolve(bench).workspace).toMatchObject({ repoPath: repo, sourceBranch: 'main' })
  })

  it('resolves a descendant of the bench', () => {
    expect(resolve(join(bench, 'desktop')).workspace).toMatchObject({ repoPath: repo })
  })

  it('returns null for an ordinary directory', () => {
    expect(resolve(repo)).toEqual({ workspace: null })
  })

  it('rejects malformed and relative directories before lookup', () => {
    expect(resolve('relative/bench')).toEqual({ workspace: null })
    expect(resolve(`${bench}\nforged`)).toEqual({ workspace: null })
  })

  it('rejects a sibling whose name only shares the bench prefix', () => {
    expect(resolve(`${bench}-other`)).toEqual({ workspace: null })
  })
})
