/**
 * bench-store — the persisted-shape migration from the collapsed `MemberStatus`
 * to the three orthogonal axes.
 *
 * ── Why migrate rather than reset ───────────────────────────────────────────
 * A bench is rebuildable, but the PINS are operator intent: they record exactly
 * which contribution was accepted into the build. Dropping the file would
 * silently re-pin everyone at their current tip on the next enrollment, which is
 * the one thing the pinned model exists to prevent. So a legacy record is read,
 * mapped onto the axes, and written back in the new shape.
 *
 * The interesting cases are `excluded` and `conflicted`: the old enum reported
 * one fact, so neither of those words carried any information about pin
 * freshness. The migration recomputes the pin from the tree hashes rather than
 * guessing -- that recovery is precisely the information the old ladder
 * destroyed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

let storeDir: string
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_STORE || actual.homedir() }
})

import { loadWorkspaces, saveWorkspaces, workspacesFile } from '../integration/bench-store'
import { setWorktreeStage, lookupWorktreeStage } from '../worktree/inventory'

let root: string

/** Write a raw workspaces file in the LEGACY shape, as an older build left it. */
function writeLegacy(members: Array<Record<string, unknown>>): void {
  const payload = {
    version: 1,
    workspaces: [{
      repoPath: '/repo',
      sourceBranch: 'josh',
      benchPath: '/bench/josh',
      benchBranch: 'ion/bench/josh',
      members,
      baseSha: 'base1234',
      lastBuiltAt: 1700000000000,
    }],
  }
  writeFileSync(workspacesFile(), JSON.stringify(payload, null, 2))
}

function legacyMember(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
    label: 'a',
    enabled: true,
    pinnedSha: 'aaa1111',
    pinnedTreeHash: 'tree-pinned',
    pinnedBaseSha: 'base-a',
    currentTreeHash: 'tree-pinned',
    status: 'integrated',
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-benchstore-'))
  storeDir = join(root, 'home')
  mkdirSync(join(storeDir, '.ion'), { recursive: true })
  process.env.ION_TEST_HOME_BENCH_STORE = storeDir
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_STORE
  rmSync(root, { recursive: true, force: true })
})

describe('legacy status migration', () => {
  it('maps integrated to a current pin that merged', () => {
    writeLegacy([legacyMember({ status: 'integrated' })])
    const m = loadWorkspaces()[0].members[0]
    expect(m.pin).toBe('current')
    expect(m.merge).toBe('merged')
  })

  it('maps pending to an empty pin', () => {
    writeLegacy([legacyMember({ status: 'pending' })])
    expect(loadWorkspaces()[0].members[0].pin).toBe('empty')
  })

  it('maps stale to a behind pin', () => {
    writeLegacy([legacyMember({ status: 'stale', currentTreeHash: 'tree-newer' })])
    expect(loadWorkspaces()[0].members[0].pin).toBe('behind')
  })

  it('maps landed to an absorbed pin', () => {
    writeLegacy([legacyMember({ status: 'landed' })])
    expect(loadWorkspaces()[0].members[0].pin).toBe('absorbed')
  })

  it('maps missing to a gone pin that was never built', () => {
    writeLegacy([legacyMember({ status: 'missing' })])
    const m = loadWorkspaces()[0].members[0]
    expect(m.pin).toBe('gone')
    expect(m.merge).toBe('unbuilt')
  })

  it('drops disabled and excluded members but preserves their workspace', () => {
    writeLegacy([
      legacyMember({ enabled: false }),
      legacyMember({ worktreePath: '/wt/b', branchName: 'wt/b', status: 'excluded' }),
    ])

    const [workspace] = loadWorkspaces()
    expect(workspace.members).toEqual([])
    expect(readFileSync(workspacesFile(), 'utf-8')).not.toContain('"enabled"')
    expect(readFileSync(workspacesFile(), 'utf-8')).not.toContain('"excluded"')
  })

  it('recovers a behind pin from a conflicted record', () => {
    writeLegacy([legacyMember({
      status: 'conflicted',
      pinnedTreeHash: 'tree-pinned', currentTreeHash: 'tree-newer',
      conflictPaths: ['x.ts'],
    })])
    const m = loadWorkspaces()[0].members[0]
    expect(m.merge).toBe('conflicted')
    expect(m.pin).toBe('behind')
    expect(m.conflictPaths).toEqual(['x.ts'])
  })

  it('reads an empty contribution as an empty pin even when marked conflicted', () => {
    // baseSha === pinnedSha means the member committed nothing of its own.
    writeLegacy([legacyMember({
      status: 'conflicted', pinnedSha: 'aaa1111', pinnedBaseSha: 'aaa1111',
    })])
    expect(loadWorkspaces()[0].members[0].pin).toBe('empty')
  })

  it('treats an unrecognisable record as the conservative pair', () => {
    // A hand-edited file, or one from a build that wrote neither shape. `empty`
    // + `unbuilt` cannot be mistaken for a successful integration, so the UI
    // offers an Update rather than claiming content the bench does not hold.
    writeLegacy([legacyMember({ status: 'not-a-real-status' })])
    const m = loadWorkspaces()[0].members[0]
    expect(m.pin).toBe('empty')
    expect(m.merge).toBe('unbuilt')
  })
})

describe('migration is one-way and runs once', () => {
  it('drops the legacy status and label from the file on the next write', () => {
    writeLegacy([legacyMember({ status: 'stale', currentTreeHash: 'tree-newer' })])

    saveWorkspaces(loadWorkspaces())

    const raw = readFileSync(workspacesFile(), 'utf-8')
    expect(raw).not.toContain('"status"')
    // `label` was a copy of the worktree's directory name -- one of the
    // duplicated worktree fields the sidecar removed.
    expect(raw).not.toContain('"label"')
    expect(raw).toContain('"pin"')
    expect(raw).toContain('"merge"')
  })

  it('round-trips the new shape unchanged', () => {
    writeLegacy([legacyMember({ status: 'stale', currentTreeHash: 'tree-newer' })])
    saveWorkspaces(loadWorkspaces())

    const first = loadWorkspaces()[0].members[0]
    saveWorkspaces(loadWorkspaces())
    const second = loadWorkspaces()[0].members[0]

    expect(second).toEqual(first)
  })

  it('migrates a good verdict into a verified work stage in the registry', () => {
    writeLegacy([legacyMember({ status: 'integrated', review: 'good' })])
    const m = loadWorkspaces()[0].members[0]
    // The verdict key is gone from the member shape...
    expect('review' in m).toBe(false)
    // ...and its meaning moved into the worktree registry.
    expect(lookupWorktreeStage('/wt/a')).toBe('verified')
  })

  it('migrates an issue verdict into a bug work stage', () => {
    writeLegacy([legacyMember({ review: 'issue' })])
    loadWorkspaces()
    expect(lookupWorktreeStage('/wt/a')).toBe('bug')
  })

  it('never overwrites a stage the operator already set', () => {
    setWorktreeStage('/wt/a', 'ready')
    writeLegacy([legacyMember({ review: 'issue' })])
    loadWorkspaces()
    // The registry is the live system; the verdict is the historical one.
    expect(lookupWorktreeStage('/wt/a')).toBe('ready')
  })

  it('strips the migrated review key from the file so migration is one-time', () => {
    writeLegacy([legacyMember({ review: 'issue' })])
    loadWorkspaces()
    // The load rewrites the file without the key; clearing the stage must not
    // resurrect the verdict on the next load.
    setWorktreeStage('/wt/a', null)
    loadWorkspaces()
    expect(lookupWorktreeStage('/wt/a')).toBeNull()
    const raw = readFileSync(workspacesFile(), 'utf-8')
    expect(raw.includes('"review"')).toBe(false)
  })

  it('ignores a review value that is not a known verdict', () => {
    writeLegacy([legacyMember({ review: 'maybe' })])
    loadWorkspaces()
    expect(lookupWorktreeStage('/wt/a')).toBeNull()
  })
})

describe('structural defence', () => {
  it('drops a member with no worktree path rather than failing the load', () => {
    writeLegacy([legacyMember(), { branchName: 'wt/broken' }])
    expect(loadWorkspaces()[0].members).toHaveLength(1)
  })

  it('treats an unreadable file as empty rather than throwing', () => {
    writeFileSync(workspacesFile(), 'not json')
    expect(loadWorkspaces()).toEqual([])
  })
})
