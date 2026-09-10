/**
 * Whether the active conversation's working directory is a git repository.
 *
 * The Git surfaces exist to show a repository. Offered against a plain
 * directory they have nothing to display, and reaching them starts real work:
 * the worktree freshness poll runs `git worktree list` against the path every
 * five seconds, and each attempt fails with "not a git repository" and is not
 * cached, because an empty answer must not be re-served to a repo that
 * recovers. On a conversation opened in a home directory that is a spawn every
 * five seconds, forever, for a directory that will never become a repo.
 *
 * One hook so the Studio dock and the Overlay button cannot drift into
 * disagreeing about when Git is available.
 */
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useRepoState } from '../stores/git'

export interface ActiveGitRepo {
  /** The active conversation's working directory, or undefined when unset. */
  directory: string | undefined
  /**
   * True only once the directory is known to be a repository.
   *
   * Undefined repo state means "not probed yet", which reads as false. That
   * is deliberate: a surface that appears and then vanishes is worse than one
   * that appears a beat late, and the probe lands with the first snapshot.
   */
  isRepo: boolean
}

export function useActiveGitRepo(): ActiveGitRepo {
  const directory = useSessionStore(
    useShallow((s) => s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory),
  )
  // '~' is the placeholder a conversation carries before a real directory is
  // resolved; it is never a repo path.
  const resolved = directory && directory !== '~' ? directory : undefined
  const repoState = useRepoState(resolved)
  return { directory: resolved, isRepo: repoState?.isGitRepo === true }
}
