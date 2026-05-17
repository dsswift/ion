/**
 * Git Zustand store — keyed by repo path.
 *
 * During migration, this coexists with useGitPollingStore.
 * After cutover (step 6), useGitPollingStore is deleted and
 * all consumers read from this store via selectors.
 */

import { create } from 'zustand'
import type { GitChangedFile } from '../../../shared/types'
import type { RepoState, GitEvent } from './types'

interface GitStoreState {
  repos: Record<string, RepoState>
  inflightOps: Record<string, string>

  /** Update repo state from a status refresh. */
  updateRepo: (path: string, data: {
    files: GitChangedFile[]
    branch: string
    ahead: number
    behind: number
    isGitRepo: boolean
  }) => void

  /** Clear repo state (e.g. on tab close). */
  clearRepo: (path: string) => void

  /** Handle a git event from main process. */
  handleEvent: (event: GitEvent) => void
}

export const useGitStore = create<GitStoreState>((set, get) => ({
  repos: {},
  inflightOps: {},

  updateRepo: (path, data) => {
    const prev = get().repos[path]
    // Signature-based dedup (same as useGitPollingStore)
    const sig = data.branch + '\n' + data.files.map((f) => `${f.staged}:${f.status}:${f.path}`).join('\n')
    const prevSig = prev
      ? prev.branch + '\n' + prev.files.map((f) => `${f.staged}:${f.status}:${f.path}`).join('\n')
      : ''
    const changed = sig !== prevSig || data.ahead !== (prev?.ahead ?? 0) || data.behind !== (prev?.behind ?? 0)

    if (changed) {
      set((state) => ({
        repos: {
          ...state.repos,
          [path]: {
            files: data.files,
            branch: data.branch,
            ahead: data.ahead,
            behind: data.behind,
            isGitRepo: data.isGitRepo,
            revision: (prev?.revision ?? 0) + 1,
          },
        },
      }))
    }
  },

  clearRepo: (path) => {
    set((state) => {
      const repos = { ...state.repos }
      delete repos[path]
      return { repos }
    })
  },

  handleEvent: (event) => {
    switch (event.kind) {
      case 'op:started':
        set((state) => ({
          inflightOps: { ...state.inflightOps, [event.repoPath]: event.kind },
        }))
        break
      case 'op:completed':
        set((state) => {
          const ops = { ...state.inflightOps }
          delete ops[event.repoPath]
          return { inflightOps: ops }
        })
        break
      default:
        // Other events trigger a refresh — the polling hook or
        // watcher will call updateRepo with fresh data.
        break
    }
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
