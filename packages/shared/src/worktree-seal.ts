/**
 * worktree-seal — a landed worktree is read-only.
 *
 * Landing is terminal: the work is merged, and a commit made in the
 * checkout afterwards could never reach the branch it came from. Every verb
 * that mutates a worktree or opens new work in it gates on this, so the
 * rule lives here rather than in each menu.
 *
 * A transferred worktree used to be the second way in here. It is not any
 * more: a transfer moves the worktree and deletes the copy it came from, so
 * there is never a sealed copy left behind to gate
 * (`server/src/transfer/remove-source.ts`).
 */

export interface WorktreeSealFacts {
  landedAt?: number | null
}

/** True when no mutating verb may run in this worktree. */
export function isWorktreeSealed(entry: WorktreeSealFacts | null | undefined): boolean {
  return !!entry && entry.landedAt != null
}

/** True when no mutating verb may run on this tab's worktree. */
export function isTabWorktreeSealed(tab: { worktree?: { landedAt?: number | null } | null }): boolean {
  return !!tab.worktree && tab.worktree.landedAt != null
}
