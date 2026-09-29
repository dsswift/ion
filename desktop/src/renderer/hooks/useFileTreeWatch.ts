/**
 * Hear about changes under a directory tree for the lifetime of the calling
 * component.
 *
 * - While mounted and enabled, the root is watched on the conversation's
 *   server (`host.shell.fsWatchTree`) and each `FsTreeChange` for it reaches
 *   `onChange`.
 * - A change that arrives while the window is hidden is not delivered. The
 *   window becoming visible again, or regaining focus, delivers one change
 *   that asks for everything to be re-read, which also covers anything a
 *   watch failed to report.
 * - Watches are counted per root across the window, so two views of one root
 *   hold one watch and the first to unmount does not end it for the other.
 */
import { useEffect, useRef } from 'react'
import type { FsTreeChange } from '@ion/shared/fs-tree-watch'
import { rDebug, rWarn } from '../rendererLogger'
import { host } from '../host/host-instance'

const watcherCounts = new Map<string, number>()
/** Roots whose `fsWatchTree` has been answered with success. */
const watchedRoots = new Set<string>()
const watchesInFlight = new Set<string>()

/** Exported for tests. */
export function _watcherCount(root: string): number {
  return watcherCounts.get(root) ?? 0
}

/** Start the watch for a root that has a consumer and no watch yet. */
function ensureWatched(root: string): void {
  if ((watcherCounts.get(root) ?? 0) === 0 || watchedRoots.has(root) || watchesInFlight.has(root)) return
  watchesInFlight.add(root)
  host.shell.fsWatchTree(root).then((result) => {
    watchesInFlight.delete(root)
    if (!result.ok) {
      rWarn('file-tree-watch', 'watch refused; the tree refreshes on window focus only', { root, error: result.error })
      return
    }
    if ((watcherCounts.get(root) ?? 0) === 0) {
      // The last consumer left while the watch was being set up.
      host.shell.fsUnwatchTree(root).catch((err) => rDebug('file-tree-watch', 'fsUnwatchTree failed', { root, error: String(err) }))
      return
    }
    watchedRoots.add(root)
    rDebug('file-tree-watch', 'watching', { root })
  }).catch((err) => {
    watchesInFlight.delete(root)
    rWarn('file-tree-watch', 'watch failed; the tree refreshes on window focus only', { root, error: String(err) })
  })
}

function acquire(root: string): void {
  watcherCounts.set(root, (watcherCounts.get(root) ?? 0) + 1)
  ensureWatched(root)
}

function release(root: string): void {
  const remaining = (watcherCounts.get(root) ?? 0) - 1
  if (remaining > 0) {
    watcherCounts.set(root, remaining)
    return
  }
  watcherCounts.delete(root)
  if (!watchedRoots.delete(root)) return
  host.shell.fsUnwatchTree(root).catch((err) => rDebug('file-tree-watch', 'fsUnwatchTree failed', { root, error: String(err) }))
}

/** The change that asks a consumer to re-read everything it shows. */
function rereadEverything(root: string): FsTreeChange {
  return { root, directories: [], overflow: true, ignoreRulesChanged: true }
}

export function useFileTreeWatch(root: string, enabled: boolean, onChange: (change: FsTreeChange) => void): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!enabled || !root || root === '~') return
    let missedWhileHidden = false
    acquire(root)

    const off = host.shell.onFileTreeChanged((change) => {
      if (change.root !== root) return
      if (document.visibilityState === 'hidden') {
        missedWhileHidden = true
        return
      }
      onChangeRef.current(change)
    })

    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible' || !missedWhileHidden) return
      missedWhileHidden = false
      rDebug('file-tree-watch', 're-reading after changes missed while hidden', { root })
      onChangeRef.current(rereadEverything(root))
    }
    const onFocus = (): void => {
      missedWhileHidden = false
      // A watch that could not be set up is tried again here.
      ensureWatched(root)
      onChangeRef.current(rereadEverything(root))
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)

    return () => {
      off()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      release(root)
    }
  }, [root, enabled])
}
