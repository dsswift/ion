/**
 * Which checkouts stay watched even when they sit inside an ignored directory.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * `gitWatcherIgnoredDirectories` defaults to `~/.ion`, and it should: that tree
 * holds conversation NDJSON, rotating logs, and settings, all written
 * constantly, and a recursive watcher over it would fire continuously for
 * writes that are not source changes.
 *
 * But Ion also stores REAL SOURCE CHECKOUTS there — worktrees at
 * `~/.ion/worktrees/<slug>` and integration benches at
 * `~/.ion/integration/<slug>`. Both matched the ignore rule, so every one of
 * them ran with the watcher suppressed: no `status:dirty` events, no revision
 * bump, and therefore no Diff panel or git Changes refresh. A conversation
 * working in its own worktree showed a frozen diff for as long as the window
 * kept focus, because the only remaining refresh path is the focus-return
 * handler. Seven checkouts on this machine were affected, each logging
 * `git_repository: watcher suppressed for ignored path`.
 *
 * ── Why an exemption and not a narrower default ─────────────────────────────
 * Narrowing the default to `~/.ion`'s noisy children (`conversations`, `logs`,
 * the jsonl files) fixes today's symptom and rots tomorrow: the next noisy
 * directory added under `~/.ion` silently reintroduces the watcher churn the
 * ignore exists to prevent, and nothing fails when someone forgets to list it.
 *
 * The exemption encodes the actual distinction instead. The ignore means "do
 * not watch Ion's own data"; a checkout is never Ion's data, wherever it
 * happens to live. That statement stays true as `~/.ion` grows.
 *
 * ── Sourced from the records, not from a path shape ─────────────────────────
 * Deliberately NOT a `startsWith('~/.ion/worktrees')` test. The registry and
 * the workspace records are what actually define a managed checkout, they are
 * already the authority every other worktree surface reads, and a path-shape
 * heuristic would exempt any stray directory that happened to be named right —
 * including a scratch folder that is genuinely noisy. Reading the records also
 * means a worktree relocated outside `~/.ion` needs no special case.
 */
import { log as _log, warn as _warn } from '../logger'
import { registeredWorktreePaths } from '../worktree/registry'
import { loadWorkspaces } from '../integration/bench-store'

const TAG = 'git.watcher-exempt'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Every managed checkout path: registered worktrees plus integration benches.
 *
 * Read fresh on each call rather than cached. This runs once per repository
 * retain (not per watch event), and a cache would go stale exactly when it
 * matters — a worktree created during the session would stay unwatched until
 * the next restart, which is the same class of silent staleness this fixes.
 *
 * Both reads degrade to empty rather than throwing: an unreadable record must
 * not stop a repository from being retained. The cost of degrading is the old
 * behaviour (an unwatched checkout with focus-return refresh), which is worse
 * than now but far better than a git panel that fails to open.
 */
export function watchedCheckoutPaths(): string[] {
  const paths: string[] = []
  try {
    paths.push(...registeredWorktreePaths())
  } catch (err) {
    warn('worktree registry unreadable; worktrees stay subject to the ignore list', {
      error: String(err),
    })
  }
  try {
    for (const workspace of loadWorkspaces()) {
      if (workspace.benchPath) paths.push(workspace.benchPath)
    }
  } catch (err) {
    warn('bench records unreadable; benches stay subject to the ignore list', {
      error: String(err),
    })
  }
  log('resolved watcher exemptions', { count: paths.length })
  return paths
}
