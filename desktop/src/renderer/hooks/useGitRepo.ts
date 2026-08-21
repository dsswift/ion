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

/**
 * Renderer-side subscription refcount, keyed by directory.
 *
 * Main keys its subscription map `webContentsId::repoPath` WITHOUT a
 * refcount: two same-window subscribers (StatusBar + GitPanel, or N
 * workspace repo sections) collide on one entry, and the first unmount's
 * gitUnsubscribe kills event delivery for every remaining subscriber in
 * this window. Refcounting here means main sees one subscribe per
 * (window, repo) and one unsubscribe when the LAST consumer leaves.
 */
const subscriberCounts: Record<string, number> = {}

/** Exported for tests. */
export function _subscriberCount(directory: string): number {
  return subscriberCounts[directory] ?? 0
}

function acquireSubscription(directory: string): void {
  const prev = subscriberCounts[directory] ?? 0
  subscriberCounts[directory] = prev + 1
  if (prev > 0) {
    // Already subscribed at the window level — the snapshot is in the git
    // store; just force a fresh read for this consumer's benefit.
    window.ion.gitRefresh(directory).catch((err) => rDebug('git', 'gitRefresh failed', { directory, error: String(err) }))
    return
  }
  window.ion.gitSubscribe(directory).then(({ snapshot }) => {
    if (snapshot) {
      useGitStore.getState().applySnapshot(snapshot)
      lastRevisionByRepo[directory] = snapshot.revision
    }
    // Force a fresh read; deltas flow back through the onGitEvent listener.
    window.ion.gitRefresh(directory).catch((err) => rDebug('git', 'gitRefresh failed', { directory, error: String(err) }))
  }).catch((err) => rDebug('git', 'gitSubscribe on mount failed', { directory, error: String(err) }))
}

function releaseSubscription(directory: string): void {
  const prev = subscriberCounts[directory] ?? 0
  if (prev <= 1) {
    delete subscriberCounts[directory]
    window.ion.gitUnsubscribe(directory).catch((err) => rDebug('git', 'gitUnsubscribe failed', { directory, error: String(err) }))
  } else {
    subscriberCounts[directory] = prev - 1
  }
}

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
    // Refcounted subscribe: the first consumer in this window subscribes
    // (applying the cached snapshot + forcing a fresh read); later consumers
    // ride the existing subscription and just refresh.
    acquireSubscription(directory)

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
      releaseSubscription(directory)
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
