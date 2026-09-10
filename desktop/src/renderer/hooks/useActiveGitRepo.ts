/**
 * Whether the active conversation's working directory is a git repository.
 *
 * This is the ONLY place that probes the active tab's directory: it always
 * subscribes (via `useGitRepo`) once a real directory is resolved, which is
 * what populates `isGitRepo` in the store in the first place. Without this,
 * `isRepo` could only ever become true for a directory some OTHER mounted
 * consumer (GitPanelRepoSection, DiffSurface) had already subscribed to —
 * and both of those only mount once the Git surface is already showing,
 * so a brand-new tab's Git tab/button could never appear on its own.
 *
 * The Git surfaces exist to show a repository. Offered against a plain
 * directory they have nothing to display, and reaching them starts real work:
 * the worktree freshness poll runs `git worktree list` against the path every
 * five seconds, and each attempt fails with "not a git repository" and is not
 * cached, because an empty answer must not be re-served to a repo that
 * recovers. On a conversation opened in a home directory that is a spawn every
 * five seconds, forever, for a directory that will never become a repo. That
 * poll is driven by opening the Git surface itself, not by this probe — the
 * probe here is a single cheap status read, refcounted with every other
 * consumer of the same directory via `useGitRepo`.
 *
 * One hook so the Studio dock and the Overlay button cannot drift into
 * disagreeing about when Git is available.
 */
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useRepoState } from '../stores/git'
import { useGitRepo } from './useGitRepo'

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
  // Subscribe unconditionally once a directory is resolved — we don't yet
  // know if it's a repo, and this call is what finds out.
  useGitRepo(resolved, resolved !== undefined)
  const repoState = useRepoState(resolved)
  return { directory: resolved, isRepo: repoState?.isGitRepo === true }
}
