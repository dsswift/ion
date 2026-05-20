import { describe, it, expect, beforeEach } from 'vitest'
import { useGitStore } from '../gitStore'
import type { RepoSnapshot, GitEvent } from '../../../../shared/types'

const REPO = '/tmp/r'

function baseSnap(over: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    repoPath: REPO,
    isGitRepo: true,
    head: { branch: 'main', detached: false, sha: 'abc' },
    upstream: { name: 'origin/main', ahead: 0, behind: 0 },
    mergeState: 'none',
    groups: { index: [], workingTree: [], untracked: [], merge: [] },
    revision: 1,
    ...over,
  }
}

describe('gitStore reducer', () => {
  beforeEach(() => {
    useGitStore.setState({ repos: {}, inflightOps: {} })
  })

  it('hydrates from snapshot', () => {
    useGitStore.getState().applySnapshot(baseSnap({
      groups: {
        index: [{ path: 'a.ts', status: 'modified', staged: true }],
        workingTree: [{ path: 'b.ts', status: 'modified', staged: false }],
        untracked: [],
        merge: [],
      },
    }))
    const r = useGitStore.getState().repos[REPO]
    expect(r.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(r.branch).toBe('main')
  })

  it('applies status:changed delta', () => {
    useGitStore.getState().applySnapshot(baseSnap({
      groups: {
        index: [],
        workingTree: [{ path: 'a.ts', status: 'modified', staged: false }],
        untracked: [],
        merge: [],
      },
    }))
    const ev: GitEvent = {
      kind: 'status:changed',
      repoPath: REPO,
      revision: 2,
      added: [{ path: 'b.ts', status: 'untracked', staged: false }],
      removed: ['a.ts'],
      modified: [],
    }
    useGitStore.getState().applyEvent(ev)
    const r = useGitStore.getState().repos[REPO]
    expect(r.files.map((f) => f.path).sort()).toEqual(['b.ts'])
    expect(r.groups.untracked.map((f) => f.path)).toEqual(['b.ts'])
    expect(r.revision).toBe(2)
  })

  it('tracks inflight ops via op:started / op:completed', () => {
    useGitStore.getState().applyEvent({ kind: 'op:started', repoPath: REPO, opId: '1', opKind: 'commit' })
    expect(useGitStore.getState().inflightOps[`${REPO}:1`]).toBe('commit')
    useGitStore.getState().applyEvent({ kind: 'op:completed', repoPath: REPO, opId: '1', ok: true, durationMs: 10 })
    expect(useGitStore.getState().inflightOps[`${REPO}:1`]).toBeUndefined()
  })

  it('updates head + upstream from delta events', () => {
    useGitStore.getState().applySnapshot(baseSnap())
    useGitStore.getState().applyEvent({
      kind: 'head:changed', repoPath: REPO, revision: 2,
      head: { branch: 'feature', detached: false, sha: 'def' },
    })
    useGitStore.getState().applyEvent({
      kind: 'upstream:changed', repoPath: REPO, revision: 3, ahead: 2, behind: 5,
    })
    const r = useGitStore.getState().repos[REPO]
    expect(r.branch).toBe('feature')
    expect(r.ahead).toBe(2)
    expect(r.behind).toBe(5)
  })
})
