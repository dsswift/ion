/**
 * Pins the read options and reply fields a client that renders git state
 * without a checkout of its own depends on: the change counts, the local-only
 * branch list, the graph lane layout, and a commit's line statistics.
 *
 * Each is additive. A call that names no option gets the reply shape it
 * always got, which the last case in each group asserts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const git = vi.hoisted(() => ({ run: vi.fn<(dir: string, args: string[]) => Promise<string>>() }))
vi.mock('../git-runner', () => ({ runGit: git.run }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../integration/bench-guard', () => ({ benchGuard: () => null }))

import { GIT_HANDLERS } from '../git-api'
import { IPC } from '@ion/shared/types'

/** Answer each git invocation by the first argument that identifies it. */
function answer(table: Record<string, string | Error>): void {
  git.run.mockImplementation(async (_dir, args) => {
    const key = Object.keys(table).find((k) => args.join(' ').includes(k))
    if (key === undefined) throw new Error(`unexpected git ${args.join(' ')}`)
    const value = table[key]
    if (value instanceof Error) throw value
    return value
  })
}

// Braces matter: a hook that RETURNS a function registers it as teardown.
beforeEach(() => { git.run.mockReset() })

describe('git.changes', () => {
  it('counts staged and unstaged entries', async () => {
    answer({
      'rev-parse': 'true',
      'branch --show-current': 'main\n',
      'rev-list': '0\n',
      // One staged modification, one unstaged modification, one untracked file.
      'status --porcelain': 'M  staged.ts\0 M unstaged.ts\0?? new.ts\0',
    })
    const result = await GIT_HANDLERS[IPC.GIT_CHANGES]({ directory: '/repo' }) as { files: Array<{ staged: boolean }>; stagedCount: number; unstagedCount: number }
    expect(result.stagedCount).toBe(result.files.filter((f) => f.staged).length)
    expect(result.unstagedCount).toBe(result.files.filter((f) => !f.staged).length)
    expect(result.stagedCount).toBe(1)
    expect(result.unstagedCount).toBe(2)
  })

  it('reports zero counts outside a repository', async () => {
    answer({ 'rev-parse': new Error('not a repo') })
    expect(await GIT_HANDLERS[IPC.GIT_CHANGES]({ directory: '/tmp' })).toEqual({ files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0, stagedCount: 0, unstagedCount: 0 })
  })
})

describe('git.branches', () => {
  it('localOnly answers with local branch names', async () => {
    answer({ 'for-each-ref': 'main\nfeature/x\n', 'branch --show-current': 'feature/x\n' })
    expect(await GIT_HANDLERS[IPC.GIT_BRANCHES]({ directory: '/repo', localOnly: true })).toEqual({ branches: ['main', 'feature/x'], current: 'feature/x' })
    expect(git.run.mock.calls.some(([, args]) => args.includes('-a'))).toBe(false)
  })

  it('localOnly carries the failure instead of an empty list that reads as "no branches"', async () => {
    answer({ 'for-each-ref': new Error('fatal: not a git repository'), 'branch --show-current': '' })
    expect(await GIT_HANDLERS[IPC.GIT_BRANCHES]({ directory: '/repo', localOnly: true })).toEqual({ branches: [], current: '', error: 'Error: fatal: not a git repository' })
  })

  it('without the option still lists every ref as an object', async () => {
    answer({ 'branch -a': 'main\t*\torigin/main\norigin/main\t \t\n' })
    expect(await GIT_HANDLERS[IPC.GIT_BRANCHES]({ directory: '/repo' })).toEqual({
      branches: [
        { name: 'main', isCurrent: true, upstream: 'origin/main', isRemote: false },
        { name: 'origin/main', isCurrent: false, upstream: null, isRemote: true },
      ],
      current: 'main',
    })
  })
})

describe('git.graph', () => {
  const twoCommits = ['b1\0bbbb\0aaaa\0Dev\x002026-01-02T00:00:00Z\0second\0HEAD -> main', 'a1\0aaaa\0\0Dev\x002026-01-01T00:00:00Z\0first\0'].join('\n')

  it('withLayout adds one lane node per commit', async () => {
    answer({ 'rev-parse': 'true', 'log': twoCommits, 'rev-list': '2\n' })
    const result = await GIT_HANDLERS[IPC.GIT_GRAPH]({ directory: '/repo', withLayout: true }) as { commits: unknown[]; graphLayout: Array<Record<string, unknown>> }
    expect(result.graphLayout).toHaveLength(result.commits.length)
    expect(Object.keys(result.graphLayout[0]).sort()).toEqual(['color', 'connections', 'hasIncoming', 'lane', 'passThroughLanes'])
  })

  it('without the option carries no layout', async () => {
    answer({ 'rev-parse': 'true', 'log': twoCommits, 'rev-list': '2\n' })
    const result = await GIT_HANDLERS[IPC.GIT_GRAPH]({ directory: '/repo' }) as Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(['commits', 'isGitRepo', 'totalCount'])
  })
})

describe('git.commitFiles', () => {
  it('aggregates line statistics and names both paths of a copy', async () => {
    answer({
      '--name-status': 'M\tsrc/a.ts\nC100\tsrc/a.ts\tsrc/b.ts\nR090\told.ts\tnew.ts\nA\timg.png\n',
      '--numstat': '3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n2\t2\tnew.ts\n-\t-\timg.png\n',
    })
    expect(await GIT_HANDLERS[IPC.GIT_COMMIT_FILES]({ directory: '/repo', hash: 'abc' })).toEqual({
      files: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'copied', oldPath: 'src/a.ts' },
        { path: 'new.ts', status: 'renamed', oldPath: 'old.ts' },
        { path: 'img.png', status: 'added' },
      ],
      stats: { filesChanged: 4, insertions: 15, deletions: 3 },
    })
  })

  it('answers empty with zeroed statistics when the commit cannot be read', async () => {
    answer({ 'diff-tree': new Error('bad object') })
    expect(await GIT_HANDLERS[IPC.GIT_COMMIT_FILES]({ directory: '/repo', hash: 'nope' })).toEqual({ files: [], stats: { filesChanged: 0, insertions: 0, deletions: 0 } })
  })
})
