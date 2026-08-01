/**
 * Worktree title announcement — the one path a new title takes to every
 * surface.
 *
 * Extracted from ipc/worktree.ts so the seed path (the title generated for the
 * conversation that started the worktree) and the operator's explicit rename
 * share a single announcer: two copies of "broadcast + push to iOS" would drift
 * the moment one grows a new surface.
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
