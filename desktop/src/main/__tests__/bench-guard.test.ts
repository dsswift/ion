/**
 * Bench write-guard tests — the UI half of "a bench refuses history writes".
 *
 * The property that matters: the OPERATOR cannot write git history inside an
 * integration bench from the git panel, because the next rebuild recreates the
 * branch and destroys the commit. The engine's workspace containment
 * (internal/workspaces) covers the same rule for AGENT tool calls; this
 * covers the IPC surface the buttons call.
 *
 * Reading, building, staging, and patch-applying must stay unblocked — that is
 * the entire purpose of the bench — so over-blocking is as much a defect as
 * under-blocking.
 *
 * These tests drive the real IPC handlers through a captured `ipcMain.handle`
 * registry rather than calling `benchGuard` directly. Testing the helper alone
 * would pass even if a handler forgot to call it, which is the actual defect
 * this file exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BENCH = '/tmp/ion-benchguard-fixture/integration/project-josh'
const MEMBER = '/tmp/ion-benchguard-fixture/worktrees/project-a3f1'
const REPO = '/tmp/ion-benchguard-fixture/repo'

/** Captured IPC handlers, keyed by channel. */
const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn)
    },
  },
}))

// The guard reads ~/.ion/integration-workspaces.json through bench-store, which
// resolves homedir() lazily on every call — so redirecting HOME here is enough
// and no module-load ordering is involved.
let home: string

// runGit must never be reached for a refused operation. Recording calls is how
// the tests prove the refusal happened BEFORE any git command ran, rather than
// after git already mutated the repository.
const gitCalls: Array<{ cwd: string; args: string[] }> = []

/**
 * The calls that would actually change the repository. Abort/continue probe
 * the in-progress operation state first (`rev-parse --git-path`, reads of
 * MERGE_HEAD) to name the right verb and to allow the bench resolve-once
 * carve-out — those reads are expected even on a refused call, so the
 * assertion that matters is "no MUTATION ran", not "no git ran".
 */
const READ_ONLY = new Set(['rev-parse', 'ls-files', 'status', 'log', 'diff', 'show', 'config'])
function mutatingGitCalls(): Array<{ cwd: string; args: string[] }> {
  return gitCalls.filter((c) => {
    const sub = c.args.find((a) => !a.startsWith('-') && a !== 'true')
    return sub !== undefined && !READ_ONLY.has(sub)
  })
}

vi.mock('../git-runner', () => ({
  runGit: async (cwd: string, args: string[]) => {
    gitCalls.push({ cwd, args })
    return ''
  },
  gitExec: async () => ({ stdout: '', stderr: '' }),
}))

let IPC: typeof import('../../shared/types').IPC

beforeEach(async () => {
  handlers.clear()
  gitCalls.length = 0

  home = mkdtempSync(join(tmpdir(), 'ion-benchguard-'))
  process.env.HOME = home
  mkdirSync(join(home, '.ion'), { recursive: true })
  writeFileSync(
    join(home, '.ion', 'integration-workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: [{
        repoPath: REPO,
        sourceBranch: 'josh',
        benchPath: BENCH,
        benchBranch: 'ion/bench/josh',
        members: [],
        baseSha: '',
        lastBuiltAt: 0,
      }],
    }),
  )

  const types = await import('../../shared/types')
  IPC = types.IPC
  const { registerGitIpc } = await import('../ipc/git')
  const { registerGitExtrasIpc } = await import('../ipc/git-extras')
  const { registerGitRebaseIpc } = await import('../ipc/git-rebase')
  registerGitIpc()
  registerGitExtrasIpc()
  registerGitRebaseIpc()
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

describe('history writes are refused inside a bench', () => {
  it('refuses a commit at the bench root', async () => {
    const result = await invoke(IPC.GIT_COMMIT, { directory: BENCH, message: 'fix' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/integration bench/i)
    // The refusal must name the remediation, or the operator just retries.
    expect(result.error).toMatch(/member worktree/i)
    // Nothing ran: the guard fires before git, not after.
    expect(gitCalls).toEqual([])
  })

  it('refuses a commit in a bench SUBDIRECTORY', async () => {
    // The exact-equality bug: a guard comparing `directory === benchPath` lets
    // every subdirectory through, and the git panel routinely operates on one.
    const result = await invoke(IPC.GIT_COMMIT, { directory: `${BENCH}/desktop/src`, message: 'fix' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/integration bench/i)
    expect(gitCalls).toEqual([])
  })

  // Each of these would be destroyed or published by the next rebuild.
  it.each([
    [() => IPC.GIT_PUSH, {}],
    [() => IPC.GIT_PULL, {}],
    [() => IPC.GIT_RESET, { hash: 'abc123', mode: 'hard' }],
    [() => IPC.GIT_CHERRY_PICK, { hash: 'abc123' }],
    [() => IPC.GIT_REVERT, { hash: 'abc123' }],
    [() => IPC.GIT_CHECKOUT, { branch: 'other' }],
    [() => IPC.GIT_CREATE_BRANCH, { name: 'wt/new' }],
    [() => IPC.GIT_DELETE_BRANCH, { branch: 'wt/old' }],
    [() => IPC.GIT_STASH_SAVE, {}],
    [() => IPC.GIT_STASH_POP, {}],
    [() => IPC.GIT_STASH_DROP, { ref: 'stash@{0}' }],
    [() => IPC.GIT_REBASE_ABORT, {}],
    [() => IPC.GIT_REBASE_CONTINUE, {}],
    [() => IPC.GIT_TAG_CREATE, { name: 'v1' }],
  ])('refuses %# inside a bench', async (channel, args) => {
    const result = await invoke((channel as () => string)(), { directory: BENCH, ...(args as object) })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/integration bench/i)
    expect(mutatingGitCalls()).toEqual([])
  })
})

describe('history writes are allowed outside a bench', () => {
  it('allows a commit in a member worktree', async () => {
    const result = await invoke(IPC.GIT_COMMIT, { directory: MEMBER, message: 'fix' })

    expect(result.ok).toBe(true)
    expect(gitCalls.length).toBeGreaterThan(0)
  })

  it('allows a commit in the repo root', async () => {
    const result = await invoke(IPC.GIT_COMMIT, { directory: REPO, message: 'fix' })

    expect(result.ok).toBe(true)
  })

  // A sibling whose path merely STARTS WITH the bench path must not match.
  // Prefix comparison without the separator would refuse real work here.
  it('allows a commit in a sibling sharing the bench path prefix', async () => {
    const result = await invoke(IPC.GIT_COMMIT, { directory: `${BENCH}-other`, message: 'fix' })

    expect(result.ok).toBe(true)
  })

  it('allows push in a member worktree', async () => {
    const result = await invoke(IPC.GIT_PUSH, { directory: MEMBER })

    expect(result.ok).toBe(true)
  })
})

describe('reading and building in a bench stay unblocked', () => {
  // Over-blocking would defeat the bench's purpose: it exists to build and test.
  it('allows reading changes inside a bench', async () => {
    const result = await invoke(IPC.GIT_CHANGES, { directory: BENCH })

    // GIT_CHANGES returns a payload rather than {ok}, so the assertion is that
    // it was NOT the refusal shape.
    expect(result.error).toBeUndefined()
    expect(result.ok).not.toBe(false)
  })

  it('allows reading a diff inside a bench', async () => {
    const result = await invoke(IPC.GIT_DIFF, { directory: BENCH, path: 'a.ts', staged: false })

    expect(result.ok).not.toBe(false)
  })

  it('allows staging inside a bench', async () => {
    // Staging touches the index, not history, and a rebuild's
    // --discard-changes already resets it. Blocking it would stop the operator
    // tidying a bench tree.
    const result = await invoke(IPC.GIT_STAGE, { directory: BENCH, paths: ['a.ts'] })

    expect(result.ok).toBe(true)
  })

  it('allows applying a patch inside a bench', async () => {
    // `git apply` is how hunk-level staging works. It creates no commit.
    const result = await invoke(IPC.GIT_APPLY_PATCH, { directory: BENCH, patch: 'diff --git a/a b/a\n' })

    expect(result.ok).toBe(true)
  })
})

describe('the guard fails open when bench state is unreadable', () => {
  // A false refusal would block legitimate commits in an ordinary worktree,
  // which is worse than missing the guard until the file is readable. The
  // engine enforces the same rule independently for agent-driven writes.
  it('allows a commit when the workspace file is missing', async () => {
    rmSync(join(home, '.ion', 'integration-workspaces.json'))

    const result = await invoke(IPC.GIT_COMMIT, { directory: BENCH, message: 'fix' })

    expect(result.ok).toBe(true)
  })

  it('allows a commit when the workspace file is corrupt', async () => {
    writeFileSync(join(home, '.ion', 'integration-workspaces.json'), 'not json{')

    const result = await invoke(IPC.GIT_COMMIT, { directory: BENCH, message: 'fix' })

    expect(result.ok).toBe(true)
  })
})
