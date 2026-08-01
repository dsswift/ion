/**
 * Bench resolve-once carve-out — the guard opens EXACTLY while a merge is in
 * progress, and only for the resolution verbs.
 *
 * Separate from bench-guard.test.ts on purpose: that file mocks `git-runner`
 * to prove refusals fire BEFORE git runs, which also blinds the operation
 * probe (`probeOperationState` reads real state files). The property under
 * test here is state-dependent — "resolution verbs pass only while MERGE_HEAD
 * exists" — so this file uses a REAL repository with a REAL in-progress merge
 * and lets the handlers run real git.
 *
 * The lifecycle asserted is the resolve-once flow end to end at the IPC layer:
 *   1. before any merge: continue/abort/accept are refused like any history verb
 *   2. mid-merge (prepared by the machinery): accept + continue pass and work
 *   3. after the merge commits: the same verbs are refused again
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

/** Captured IPC handlers, keyed by channel. */
const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn)
    },
  },
}))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let home: string
let bench: string
let IPC: typeof import('../../shared/types').IPC

/** A repo at the bench path with a CONFLICTED merge available on `feature`. */
function makeConflictableRepo(): void {
  mkdirSync(bench, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', bench], { encoding: 'utf-8' })
  git(bench, 'config', 'user.email', 'dev@example.com')
  git(bench, 'config', 'user.name', 'Dev')
  git(bench, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(bench, 'shared.txt'), 'base\n')
  git(bench, 'add', '-A')
  git(bench, 'commit', '-m', 'base')
  git(bench, 'switch', '-c', 'feature')
  writeFileSync(join(bench, 'shared.txt'), 'from feature\n')
  git(bench, 'add', '-A')
  git(bench, 'commit', '-m', 'feature change')
  git(bench, 'switch', 'main')
  writeFileSync(join(bench, 'shared.txt'), 'from main\n')
  git(bench, 'add', '-A')
  git(bench, 'commit', '-m', 'main change')
}

beforeEach(async () => {
  handlers.clear()
  home = mkdtempSync(join(tmpdir(), 'ion-benchresolve-'))
  process.env.HOME = home
  bench = join(home, 'integration', 'project-josh')
  mkdirSync(join(home, '.ion'), { recursive: true })
  writeFileSync(
    join(home, '.ion', 'integration-workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: [{
        repoPath: join(home, 'repo'),
        sourceBranch: 'josh',
        benchPath: bench,
        benchBranch: 'ion/bench/josh',
        members: [],
        baseSha: '',
        lastBuiltAt: 0,
      }],
    }),
  )
  makeConflictableRepo()

  const types = await import('../../shared/types')
  IPC = types.IPC
  const { registerGitRebaseIpc } = await import('../ipc/git-rebase')
  const { registerGitConflictsIpc } = await import('../ipc/git-conflicts')
  registerGitRebaseIpc()
  registerGitConflictsIpc()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.resetModules()
})

async function invoke(channel: string, args: Record<string, unknown>): Promise<{ ok?: boolean; error?: string }> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return (await handler({}, args)) as { ok?: boolean; error?: string }
}

function startConflictedMerge(): void {
  try {
    git(bench, 'merge', '--no-ff', '-m', 'ion-bench: test', 'feature')
    throw new Error('expected the merge to conflict')
  } catch {
    // In progress — MERGE_HEAD exists, shared.txt is unmerged.
  }
}

describe('resolution verbs are refused while NO merge is in progress', () => {
  it('refuses continue, abort, and accept on a quiescent bench', async () => {
    const cont = await invoke(IPC.GIT_REBASE_CONTINUE, { directory: bench })
    expect(cont.ok).toBe(false)
    expect(cont.error).toMatch(/integration bench/i)

    const abort = await invoke(IPC.GIT_REBASE_ABORT, { directory: bench })
    expect(abort.ok).toBe(false)
    expect(abort.error).toMatch(/integration bench/i)

    const accept = await invoke(IPC.GIT_CONFLICT_ACCEPT, { directory: bench, path: 'shared.txt', side: 'ours' })
    expect(accept.ok).toBe(false)
    expect(accept.error).toMatch(/integration bench/i)
  })
})

describe('resolution verbs pass while a merge IS in progress', () => {
  it('accepts a side and continues the merge to completion', async () => {
    startConflictedMerge()

    const accept = await invoke(IPC.GIT_CONFLICT_ACCEPT, { directory: bench, path: 'shared.txt', side: 'theirs' })
    expect(accept.ok).toBe(true)

    const cont = await invoke(IPC.GIT_REBASE_CONTINUE, { directory: bench })
    expect(cont.ok).toBe(true)

    // The merge committed: MERGE_HEAD is gone and the resolution is HEAD.
    expect(git(bench, 'log', '-1', '--format=%s').trim()).toContain('ion-bench')
  })

  it('aborts an in-progress merge', async () => {
    startConflictedMerge()

    const abort = await invoke(IPC.GIT_REBASE_ABORT, { directory: bench })
    expect(abort.ok).toBe(true)
    expect(git(bench, 'status', '--porcelain').trim()).toBe('')
  })

  it('still refuses non-resolution history verbs mid-merge', async () => {
    startConflictedMerge()

    // The carve-out is scoped to the resolution verbs, not to the merge state:
    // a rebase inside the bench is destructive whether or not a merge is open.
    const rebase = await invoke(IPC.GIT_REBASE_EXEC, { directory: bench, onto: 'main', commits: [] })
    expect(rebase.ok).toBe(false)
    expect(rebase.error).toMatch(/integration bench/i)
  })
})

describe('the guard closes again after the merge completes', () => {
  it('refuses the resolution verbs once the merge has been committed', async () => {
    startConflictedMerge()
    await invoke(IPC.GIT_CONFLICT_ACCEPT, { directory: bench, path: 'shared.txt', side: 'ours' })
    await invoke(IPC.GIT_REBASE_CONTINUE, { directory: bench })

    const accept = await invoke(IPC.GIT_CONFLICT_ACCEPT, { directory: bench, path: 'shared.txt', side: 'ours' })
    expect(accept.ok).toBe(false)
    expect(accept.error).toMatch(/integration bench/i)
  })
})
