import { create } from 'zustand'
import { useEffect, useRef } from 'react'
import type { GitChangedFile } from '../../shared/types'

interface GitPollingState {
  files: GitChangedFile[]
  branch: string
  ahead: number
  behind: number
  refreshKey: number
  /** Manually trigger a refresh (e.g. after commit/stage/discard) */
  refresh: () => void
  /** Internal — called by the polling hook to update state */
  _update: (data: { files: GitChangedFile[]; branch: string; ahead: number; behind: number }) => void
}

export const useGitPollingStore = create<GitPollingState>((set, get) => ({
  files: [],
  branch: '',
  ahead: 0,
  behind: 0,
  refreshKey: 0,
  refresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
  _update: (data) => {
    const prev = get()
    const sig = data.branch + '\n' + data.files.map((f) => f.status + f.path).join('\n')
    const prevSig = prev.branch + '\n' + prev.files.map((f) => f.status + f.path).join('\n')
    const changed = sig !== prevSig || data.ahead !== prev.ahead || data.behind !== prev.behind
    if (changed) {
      set({
        files: data.files,
        branch: data.branch,
        ahead: data.ahead,
        behind: data.behind,
        // Bump refreshKey so graph consumers know to reload
        refreshKey: prev.refreshKey + 1,
      })
    }
  },
}))

const POLL_INTERVAL = 5000

/**
 * Starts the single git polling interval for the given directory.
 * Mount this once (in StatusBar or a top-level component).
 * All consumers read from useGitPollingStore.
 */
export function useGitPolling(directory: string, isGitRepo: boolean) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const refreshKey = useGitPollingStore((s) => s.refreshKey)
  const update = useGitPollingStore((s) => s._update)

  useEffect(() => {
    if (!isGitRepo || !directory || directory === '~') return

    let cancelled = false

    const load = async () => {
      try {
        const result = await window.coda.gitChanges(directory)
        if (cancelled) return
        update({ files: result.files, branch: result.branch, ahead: result.ahead, behind: result.behind })
      } catch {}
    }

    load()
    intervalRef.current = setInterval(load, POLL_INTERVAL)

    return () => {
      cancelled = true
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [directory, isGitRepo, refreshKey, update])
}
