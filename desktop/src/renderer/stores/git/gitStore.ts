/**
 * Git Zustand store — keyed by repo path.
 *
 * Fed by the main process via `ion:git-event` + `ion:git-snapshot`. Applies
 * deltas with Immer to keep React subscriptions cheap.
 */

import { create } from 'zustand'
import { produce } from 'immer'
import type { GitChangedFile, GitEvent, RepoSnapshot } from '../../../shared/types'
import { emptyRepoState, snapshotToRepoState } from './types'
import type { RepoState } from './types'

interface GitStoreState {
  repos: Record<string, RepoState>
  inflightOps: Record<string, string>

  applySnapshot: (snap: RepoSnapshot) => void
  applyEvent: (event: GitEvent) => void
  clearRepo: (path: string) => void
}

function syncLegacyMirror(state: RepoState): void {
  state.files = [
    ...state.groups.index,
    ...state.groups.workingTree,
    ...state.groups.untracked,
    ...state.groups.merge,
  ]
  state.branch = state.head.branch ?? ''
  state.ahead = state.upstream.ahead
  state.behind = state.upstream.behind
}

function applyStatusDelta(
  state: RepoState,
  delta: { added: GitChangedFile[]; removed: string[]; modified: GitChangedFile[] },
): void {
  const removed = new Set(delta.removed)
  const groupFor = (f: GitChangedFile): GitChangedFile[] => {
    if (f.status === 'conflict') return state.groups.merge
    if (f.status === 'untracked') return state.groups.untracked
    if (f.staged) return state.groups.index
    return state.groups.workingTree
  }
  for (const key of Object.keys(state.groups) as Array<keyof typeof state.groups>) {
    state.groups[key] = state.groups[key].filter((f) => !removed.has(f.path))
  }
  for (const f of delta.modified) {
    const g = groupFor(f)
    const idx = g.findIndex((x) => x.path === f.path && x.staged === f.staged)
    if (idx >= 0) g[idx] = f
    else g.push(f)
  }
  for (const f of delta.added) {
    const g = groupFor(f)
    if (!g.find((x) => x.path === f.path && x.staged === f.staged)) g.push(f)
  }
}

export const useGitStore = create<GitStoreState>((set) => ({
  repos: {},
  inflightOps: {},

  applySnapshot: (snap) => {
    set(produce((draft: GitStoreState) => {
      draft.repos[snap.repoPath] = snapshotToRepoState(snap)
    }))
  },

  applyEvent: (event) => {
    set(produce((draft: GitStoreState) => {
      const path = event.repoPath
      if (!draft.repos[path]) draft.repos[path] = emptyRepoState()
      const repo = draft.repos[path]
      const knownRevision = (event as { revision?: number }).revision
      if (typeof knownRevision === 'number') repo.revision = knownRevision

      switch (event.kind) {
        case 'status:changed':
          applyStatusDelta(repo, event)
          syncLegacyMirror(repo)
          break
        case 'head:changed':
          repo.head = event.head
          repo.branch = event.head.branch ?? ''
          break
        case 'upstream:changed':
          repo.upstream.ahead = event.ahead
          repo.upstream.behind = event.behind
          repo.ahead = event.ahead
          repo.behind = event.behind
          break
        case 'merge:changed':
          repo.mergeState = event.state
          break
        case 'refs:changed':
          // Branch picker re-reads on this signal.
          break
        case 'op:started':
          draft.inflightOps[`${event.repoPath}:${event.opId}`] = event.opKind
          break
        case 'op:completed':
        case 'op:cancelled':
          delete draft.inflightOps[`${event.repoPath}:${event.opId}`]
          break
      }
    }))
  },

  clearRepo: (path) => {
    set(produce((draft: GitStoreState) => {
      delete draft.repos[path]
    }))
  },
}))

// ─── Selectors ───

export function useRepoState(path: string | undefined): RepoState | undefined {
  return useGitStore((s) => path ? s.repos[path] : undefined)
}

export function useRepoFiles(path: string | undefined): GitChangedFile[] {
  return useGitStore((s) => path ? s.repos[path]?.files ?? [] : [])
}

export function useRepoBranch(path: string | undefined): string {
  return useGitStore((s) => path ? s.repos[path]?.branch ?? '' : '')
}

export function useRepoGroups(path: string | undefined) {
  return useGitStore((s) => path ? s.repos[path]?.groups : undefined)
}

export function useRepoMergeState(path: string | undefined) {
  return useGitStore((s) => path ? (s.repos[path]?.mergeState ?? 'none') : 'none')
}
