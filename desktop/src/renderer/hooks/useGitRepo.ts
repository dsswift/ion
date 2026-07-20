/**
 * Subscribe to a repo's git events for the lifetime of the calling component.
 *
 * - On mount: requests a snapshot via `window.ion.gitSubscribe(directory)` and
 *   applies it to `useGitStore`. Immediately after, fires
 *   `window.ion.gitRefresh(directory)` so the snapshot we display reflects a
 *   fresh read rather than whatever the watcher last cached. The git watcher
 *   is best-effort — never trust it as the only path to a fresh snapshot.
 * - For all subsequent events: a single global listener (mounted once) routes
 *   `ion:git-event` payloads to `useGitStore.applyEvent`.
 * - On window focus: refresh the current directory so the user sees fresh
 *   state when returning to Ion (covers the case where the watcher dropped
 *   events while the window was blurred).
 * - On unmount / dir change: calls `gitUnsubscribe`.
 *
 * Detects revision gaps (events arriving with revision > previous + N for some
 * N or events for an unknown repo) and re-snapshots.
 */

import { useEffect, useRef } from 'react'
import { useGitStore } from '../stores/git'
import { useSessionStore } from '../stores/sessionStore'
import { rDebug } from '../rendererLogger'

let listenerInstalled = false
const lastRevisionByRepo: Record<string, number> = {}

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
        }).catch((err) => rDebug("git", "gitSubscribe snapshot apply failed", { repoPath, error: String(err) }))
        return
      }
      lastRevisionByRepo[repoPath] = next
    }
    useGitStore.getState().applyEvent(event)
  })
}

export function useGitRepo(directory: string | undefined, isGitRepo: boolean): void {
  const prevDirRef = useRef<string | undefined>(undefined)
  // Subscribe to activeTabId so we re-fire a refresh when the user switches
  // tabs, even when the new tab shares the same working directory. The
  // directory-keyed useEffect below doesn't fire in that case.
  const activeTabId = useSessionStore((s) => s.activeTabId)

  useEffect(() => {
    installGlobalListener()
    if (!directory || !isGitRepo || directory === '~') return

    let cancelled = false
    // Subscribe first (returns the cached snapshot if any) and apply it
    // immediately so the UI has something to render. Then fire gitRefresh
    // so the snapshot is replaced with a fresh read on every mount — covers
    // the silent-staleness path where the watcher missed events.
    window.ion.gitSubscribe(directory).then(({ snapshot }) => {
      if (cancelled) return
      if (snapshot) {
        useGitStore.getState().applySnapshot(snapshot)
        lastRevisionByRepo[directory] = snapshot.revision
      }
      // Force a fresh read; deltas flow back through the onGitEvent listener.
      window.ion.gitRefresh(directory).catch((err) => rDebug("git", "gitRefresh failed", { directory, error: String(err) }))
    }).catch((err) => rDebug('git', 'gitSubscribe on mount failed', { directory, error: String(err) }))

    // Refresh on window focus return — the watcher may have dropped events
    // while blurred, and even when it didn't, FSEvents itself can silently
    // stop delivering. Belt-and-braces: always re-read on focus.
    const onWindowFocus = (): void => {
      if (cancelled) return
      window.ion.gitRefresh(directory).catch((err) => rDebug("git", "gitRefresh failed", { directory, error: String(err) }))
    }
    window.addEventListener('focus', onWindowFocus)

    prevDirRef.current = directory
    return () => {
      cancelled = true
      window.removeEventListener('focus', onWindowFocus)
      window.ion.gitUnsubscribe(directory).catch((err) => rDebug("git", "gitUnsubscribe failed", { directory, error: String(err) }))
    }
  }, [directory, isGitRepo])

  // Refresh on tab switch — fires even when the new tab shares the same
  // working directory. Skips the initial mount (the [directory, isGitRepo]
  // effect above already refreshes then).
  const initialTabRef = useRef(true)
  useEffect(() => {
    if (initialTabRef.current) {
      initialTabRef.current = false
      return
    }
    if (!directory || !isGitRepo || directory === '~') return
    window.ion.gitRefresh(directory).catch((err) => rDebug("git", "gitRefresh failed", { directory, error: String(err) }))
  }, [activeTabId, directory, isGitRepo])
}
