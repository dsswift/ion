import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Pins the fix for the .git/index.lock race.
 *
 * `git status` (and the other readers the desktop polls) opportunistically
 * refresh the on-disk index, which takes .git/index.lock. The desktop reads git
 * state frequently, so without --no-optional-locks those reads collide with
 * whatever the operator is running in the same repo and their rebase / amend /
 * squash dies with "Unable to create '.git/index.lock': File exists".
 *
 * These assert on the argv actually handed to git, captured by mocking the
 * exec layer. Asserting on behavior would not distinguish fixed from broken —
 * git readers succeed either way; only the locking side effect differs.
 */

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: unknown,
    cb: (e: unknown, r: { stdout: string; stderr: string }) => void,
  ) => {
    execFileMock(file, args, opts)
    cb(null, { stdout: '', stderr: '' })
    return undefined as never
  },
}))

vi.mock('../logger', () => ({ log: vi.fn() }))

import { runGit } from '../git-runner'

function argvFor(call: number): string[] {
  return execFileMock.mock.calls[call][1] as string[]
}

describe('runGit --no-optional-locks', () => {
  beforeEach(() => execFileMock.mockClear())

  it.each([
    ['status', ['status', '--porcelain=v1', '-uall']],
    ['rev-parse', ['rev-parse', 'HEAD']],
    ['log', ['log', '--oneline', '-5']],
    ['diff', ['diff', '--name-only']],
    ['worktree', ['worktree', 'list', '--porcelain']],
    ['blame', ['blame', '--porcelain', 'file.ts']],
  ])('prefixes read-only %s', async (_label, args) => {
    await runGit('/repo', args)
    expect(argvFor(0)[0]).toBe('--no-optional-locks')
    // The caller's own arguments must survive untouched, in order.
    expect(argvFor(0).slice(1)).toEqual(args)
  })

  it.each([
    ['commit', ['commit', '-m', 'x']],
    ['add', ['add', '.']],
    ['rebase', ['rebase', 'main']],
    ['checkout', ['checkout', 'main']],
    ['stash', ['stash', 'push']],
    ['push', ['push', 'origin', 'main']],
  ])('leaves mutating %s alone', async (_label, args) => {
    await runGit('/repo', args)
    expect(argvFor(0)).toEqual(args)
  })

  it('skips leading -c config pairs to find the subcommand', async () => {
    await runGit('/repo', ['-c', 'core.quotepath=false', 'status', '--short'])
    expect(argvFor(0)[0]).toBe('--no-optional-locks')
    expect(argvFor(0)).toContain('core.quotepath=false')
  })

  it('does not treat a -c value as a mutating subcommand', async () => {
    // 'commit' here is a config value, not the subcommand — the real
    // subcommand is the read-only 'log', so the flag still applies.
    await runGit('/repo', ['-c', 'alias.x=commit', 'log', '-1'])
    expect(argvFor(0)[0]).toBe('--no-optional-locks')
  })
})
