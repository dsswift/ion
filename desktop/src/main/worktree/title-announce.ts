/**
 * Worktree title announcement — the one path a new title takes to every
 * surface.
 *
 * Extracted from ipc/worktree.ts so the first-prompt titling path and the
 * inventory-driven backfill (autotitle-backfill.ts) share a single announcer:
 * two copies of "broadcast + push to iOS" would drift the moment one grows a
 * new surface.
 *
 * Broadcast (not webContents.send): both renderer windows must repaint their
 * rows — the git panel and the ATV mirror would otherwise disagree, one
 * showing the machine slug while the other shows the title (and
 * `make check-atv-parity` fails the build for exactly this reason). The iOS
 * push goes through the worktree state projection so phones see the rename
 * without waiting for their next manual refresh.
 */
import { broadcast } from '../broadcast'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.title'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Longest prompt/subject text the titling round-trip is given.
 *
 * The engine truncates on its side too; trimming here keeps a pasted stack
 * trace out of the IPC payload rather than shipping it across the bridge to be
 * discarded.
 */
export const MAX_TITLE_INPUT_CHARS = 2000

/** Announce a worktree's new title to every renderer and to iOS. */
export async function announceWorktreeTitle(
  repoPath: string,
  worktreePath: string,
  title: string,
): Promise<void> {
  broadcast('ion:worktree-titled', { repoPath, worktreePath, title })
  if (!repoPath) {
    log('title announced without a repo path; skipping the iOS push', { worktree_path: worktreePath })
    return
  }
  try {
    const { pushWorktreeState } = await import('../remote/handlers/worktree')
    await pushWorktreeState(repoPath)
  } catch (err) {
    // The desktop rows are already correct; only the phone is briefly stale,
    // and its next refresh corrects it. Never fatal to the rename.
    warn('could not push worktree state after a rename', {
      repo_path: repoPath, worktree_path: worktreePath, error: String(err),
    })
  }
}
