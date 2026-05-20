/**
 * Subscribe to a repo's git events for the lifetime of the calling component.
 *
 * - On mount: requests a snapshot via `window.ion.gitSubscribe(directory)` and
 *   applies it to `useGitStore`.
 * - For all subsequent events: a single global listener (mounted once) routes
 *   `ion:git-event` payloads to `useGitStore.applyEvent`.
 * - On unmount / dir change: calls `gitUnsubscribe`.
 *
 * Detects revision gaps (events arriving with revision > previous + N for some
 * N or events for an unknown repo) and re-snapshots.
 */

import { useEffect, useRef } from 'react'
import { useGitStore } from '../stores/git'

let listenerInstalled = false
let lastRevisionByRepo: Record<string, number> = {}

function installGlobalListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  window.ion.onGitEvent((event) => {
    const next = (event as { revision?: number }).revision
    const repoPath = event.repoPath
    const last = lastRevisionByRepo[repoPath] ?? 0
    if (typeof next === 'number') {
      if (next < last) {
        window.ion.gitSubscribe(repoPath).then(({ snapshot }) => {
          if (snapshot) {
            useGitStore.getState().applySnapshot(snapshot)
            lastRevisionByRepo[repoPath] = snapshot.revision
          }
        }).catch(() => {})
        return
      }
      lastRevisionByRepo[repoPath] = next
    }
    useGitStore.getState().applyEvent(event)
  })
}

export function useGitRepo(directory: string | undefined, isGitRepo: boolean): void {
  const prevDirRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    installGlobalListener()
    if (!directory || !isGitRepo || directory === '~') return

    let cancelled = false
    window.ion.gitSubscribe(directory).then(({ snapshot }) => {
      if (cancelled) return
      if (snapshot) {
        useGitStore.getState().applySnapshot(snapshot)
        lastRevisionByRepo[directory] = snapshot.revision
      }
    }).catch(() => {})

    prevDirRef.current = directory
    return () => {
      cancelled = true
      window.ion.gitUnsubscribe(directory).catch(() => {})
    }
  }, [directory, isGitRepo])
}
