/**
 * Subscribe to a repo's git events for the lifetime of the calling component.
 *
 * - On mount: requests a snapshot via `host.shell.gitSubscribe(directory)` and
 *   applies it to `useGitStore`. Immediately after, fires
 *   `host.shell.gitRefresh(directory)` so the snapshot we display reflects a
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
import { useGitStore } from '@ion/server/store/git'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { rDebug, rWarn } from '../rendererLogger'
import { host } from '../host/host-instance'

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

/**
 * Directories whose `gitSubscribe` has succeeded at least once, and the
 * retry timer for those whose latest attempt failed.
 *
 * A subscribe can fail for reasons that pass: the one bridged call at boot
 * timed out while the server was busy, and nothing here ever tried again.
 * The refcount still went up, so every later consumer of the same directory
 * saw "already subscribed" and only refreshed -- against a repository the
 * store had never heard of. The Git dock tab, which needs the snapshot's
 * `isGitRepo`, stayed hidden for the rest of the session while the Surface
 * Git tab (a different subscriber path) worked. A failed subscribe now
 * retries with backoff for as long as a consumer is mounted, and a consumer
 * arriving during a failure re-subscribes instead of refreshing.
 */
const subscribedDirectories = new Set<string>()
/** Directories with a `gitSubscribe` currently awaiting its answer. */
const subscribesInFlight = new Set<string>()
const retryTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const retryDelaysMs: Record<string, number> = {}
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000

/** Exported for tests. */
export function _isSubscribed(directory: string): boolean {
  return subscribedDirectories.has(directory)
}

function clearRetry(directory: string): void {
  const timer = retryTimers[directory]
  if (timer) clearTimeout(timer)
  delete retryTimers[directory]
  delete retryDelaysMs[directory]
}

function scheduleRetry(directory: string): void {
  if (retryTimers[directory]) return
  const delay = retryDelaysMs[directory] ?? RETRY_BASE_MS
  retryDelaysMs[directory] = Math.min(delay * 2, RETRY_MAX_MS)
  rDebug('git', 'gitSubscribe retry scheduled', { directory, delay_ms: delay })
  retryTimers[directory] = setTimeout(() => {
    delete retryTimers[directory]
    if ((subscriberCounts[directory] ?? 0) === 0 || subscribedDirectories.has(directory)) return
    subscribe(directory)
  }, delay)
}

/** One subscribe attempt: snapshot into the store on success, retry on failure while consumers remain. */
function subscribe(directory: string): void {
  subscribesInFlight.add(directory)
  host.shell.gitSubscribe(directory).then(({ snapshot }) => {
    subscribesInFlight.delete(directory)
    if ((subscriberCounts[directory] ?? 0) === 0) return
    subscribedDirectories.add(directory)
    clearRetry(directory)
    if (snapshot) {
      useGitStore.getState().applySnapshot(snapshot)
      lastRevisionByRepo[directory] = snapshot.revision
    }
    // Force a fresh read; deltas flow back through the onGitEvent listener.
    host.shell.gitRefresh(directory).catch((err) => rDebug('git', 'gitRefresh failed', { directory, error: String(err) }))
  }).catch((err) => {
    subscribesInFlight.delete(directory)
    rWarn('git', 'gitSubscribe failed; will retry while a consumer is mounted', { directory, error: String(err) })
    if ((subscriberCounts[directory] ?? 0) > 0) scheduleRetry(directory)
  })
}

/** Exported for tests. */
export function _subscriberCount(directory: string): number {
  return subscriberCounts[directory] ?? 0
}

function acquireSubscription(directory: string): void {
  const prev = subscriberCounts[directory] ?? 0
  subscriberCounts[directory] = prev + 1
  if (prev > 0 && subscribedDirectories.has(directory)) {
    // Already subscribed at the window level — the snapshot is in the git
    // store; just force a fresh read for this consumer's benefit.
    host.shell.gitRefresh(directory).catch((err) => rDebug('git', 'gitRefresh failed', { directory, error: String(err) }))
    return
  }
  if (prev > 0 && subscribesInFlight.has(directory)) {
    // The first consumer's subscribe is still awaiting its answer; this
    // consumer rides it, as the refcount promises (one subscribe per window
    // and repository).
    return
  }
  if (prev > 0) {
    // A consumer is already waiting on a subscribe that FAILED and is
    // awaiting its retry. Try now rather than refreshing a repository the
    // store does not know.
    clearRetry(directory)
  }
  subscribe(directory)
}

function releaseSubscription(directory: string): void {
  const prev = subscriberCounts[directory] ?? 0
  if (prev <= 1) {
    delete subscriberCounts[directory]
    clearRetry(directory)
    subscribedDirectories.delete(directory)
    subscribesInFlight.delete(directory)
    host.shell.gitUnsubscribe(directory).catch((err) => rDebug('git', 'gitUnsubscribe failed', { directory, error: String(err) }))
  } else {
    subscriberCounts[directory] = prev - 1
  }
}

function installGlobalListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  host.shell.onGitEvent((event) => {
    const next = (event as { revision?: number }).revision
    const repoPath = event.repoPath
    const last = lastRevisionByRepo[repoPath] ?? 0
    if (typeof next === 'number') {
      if (next < last) {
        host.shell.gitSubscribe(repoPath).then(({ snapshot }) => {
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
      host.shell.gitRefresh(directory).catch((err) => rDebug("git", "gitRefresh failed", { directory, error: String(err) }))
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
    host.shell.gitRefresh(directory).catch((err) => rDebug("git", "gitRefresh failed", { directory, error: String(err) }))
  }, [activeTabId, directory, isGitRepo])
}
