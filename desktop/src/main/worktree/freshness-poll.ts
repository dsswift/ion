/**
 * Worktree + bench freshness poll — the main-process owner of "is what the
 * operator is looking at still true?".
 *
 * ── The failure this exists to fix ──────────────────────────────────────────
 * Worktree rows are a join of two live git facts (dirty state, unlanded count,
 * base staleness) and one record (the bench's pin verdicts). Both go stale the
 * moment anything commits, and nothing in the app noticed.
 *
 * The old refresh was a 5s `setInterval` inside `WorktreeListSection.tsx`. That
 * component was deleted when the Inbox took over worktree navigation, and the
 * timer went with it. What replaced it — an effect in `InboxSidebar` keyed on
 * the JSON list of project keys — only fires when the SET of projects changes,
 * which is essentially never during a working session. So after the Inbox first
 * mounted, git was never re-read: a worktree with 34 uncommitted files showed no
 * dirty marker, a bench assembled nine hours earlier still read as current, and
 * the pin-update control never appeared for a member four commits ahead of its
 * pin. Observed: 22 minutes with zero crawls while the git watcher for the same
 * repo logged over a thousand filesystem events.
 *
 * ── Why this is a poll, and why it lives in main ────────────────────────────
 * A watcher would be more precise, but the precision is not reachable cheaply:
 * `GitRepository`'s watchers are started by a renderer mounting `useGitRepo` on
 * a path, and worktrees are separate checkouts under `~/.ion/worktrees/` that no
 * panel mounts. Covering them would mean owning a recursive FSEvents pair per
 * worktree, started and stopped on register/retire, scaling with worktree count
 * (25 have been open at once) — new lifecycle machinery whose failure mode is a
 * silently stale row, which is the exact bug being fixed.
 *
 * A poll's cost is bounded and knowable instead. The crawl is already cached by
 * sha pair (inventory-appraise.ts), coalesced and TTL'd (inventory-service.ts),
 * so a tick where nothing moved is a handful of spawns and no appraisal work.
 *
 * It lives in MAIN, not in a renderer, because there are three consumers — the
 * overlay, the Studio mirror, and iOS — and a renderer-owned timer means the
 * work happens per window and stops when that window is gone. One crawl in main
 * feeds all three: the owner renderer refreshes its store (and its existing
 * publish path carries the Studio mirror), and iOS gets a pushed projection.
 *
 * ── Quiescence is a hard requirement, not an optimisation ───────────────────
 * This ticks forever, and its consumers re-render from what it writes. Both
 * downstream refreshes already compare structurally and keep the previous
 * reference when nothing changed (`refreshWorktreeInventory`, `refreshBench`),
 * so an unchanged tick must produce no store write, no snapshot publish, and no
 * iOS push. A tick that always writes would recreate the render loop that
 * `1f3e7f7576` fixed, at 5-second intervals, forever.
 */
import { state } from '../state'
import { broadcast } from '../broadcast'
import { IPC } from '../../shared/types'
import { focusState } from '../git/focus-state'
import { log as _log, debug as _debug, warn as _warn } from '../logger'
import { registeredRepoPaths } from './registry'
import { getWorktreeInventory } from './inventory-service'
import { resolveInventoryAlias } from './inventory-cache'

const TAG = 'worktree.freshness'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Tick period. Matches the cadence the deleted panel poll used and the one the
 * remote snapshot poll already runs at, so this adds no new timing vocabulary.
 * It is also the inventory cache's TTL, which means a tick is never served a
 * cached answer from its own previous tick.
 */
export const FRESHNESS_POLL_MS = 5000

let timer: ReturnType<typeof setInterval> | null = null
/** Guards against a slow tick overlapping the next interval firing. */
let ticking = false

/**
 * Repos to crawl this tick.
 *
 * The registry is authoritative for "which repos does Ion manage worktrees in",
 * and it is readable from main with no window open — which is what lets this
 * run without a renderer telling it what to watch. Repos that currently have a
 * bench but no registered worktree are added too: a bench's own staleness and
 * assembly age still need refreshing, and a bench can outlive its members.
 */
async function reposToPoll(): Promise<string[]> {
  const repos = new Set(registeredRepoPaths())
  try {
    const { loadWorkspaces } = await import('../integration/bench-store')
    for (const workspace of loadWorkspaces()) {
      if (workspace.repoPath) repos.add(workspace.repoPath)
    }
  } catch (err) {
    // The inventory half still runs. A bench record that cannot be read is
    // already handled downstream (bench-tool-policy fails open on the same
    // condition), so this degrades rather than skipping the whole tick.
    warn('bench records unreadable while choosing repos to poll', { error: String(err) })
  }
  // Collapse aliases: a repo reachable as both the main clone and a worktree
  // path is ONE crawl. `resolveInventoryAlias` returns the path unchanged until
  // a crawl has taught it the mapping, so the first tick may include both and
  // every later tick collapses them.
  const canonical = new Set<string>()
  for (const repo of repos) {
    if (!repo || repo === '~') continue
    canonical.add(resolveInventoryAlias(repo))
  }
  return [...canonical]
}

/**
 * One pass: crawl each repo, then ask the consumers to re-read.
 *
 * The crawl here is deliberately NOT the thing that updates any store. It warms
 * the shared inventory cache in main, and then the consumers read through that
 * same cache — so the owner renderer's `refreshWorkspaceViews`, the Studio
 * mirror's hydration, and the iOS projection all resolve from one crawl per
 * repo per tick instead of three.
 *
 * Exported so tests can drive a single tick without a timer.
 */
export async function pollWorktreeFreshnessOnce(): Promise<void> {
  const repos = await reposToPoll()
  if (repos.length === 0) {
    debug('no repos to poll')
    return
  }

  for (const repoPath of repos) {
    try {
      await getWorktreeInventory(repoPath)
    } catch (err) {
      // One bad repo (deleted directory, git failure) must not stop the rest.
      warn('inventory crawl failed during freshness poll', {
        repo_path: repoPath,
        error: String(err),
      })
    }
  }

  // Ask the owner renderer to re-read both surfaces. It owns the store the
  // overlay renders and the projection the Studio mirror consumes, and both of
  // its refresh actions already no-op structurally when nothing changed — so a
  // quiescent tick ends here with no store write and no re-render.
  broadcast(IPC.WORKTREE_FRESHNESS_TICK, { repoPaths: repos })

  // iOS reads a main-built projection rather than the renderer store, so it
  // needs its own push. Only when a device is actually connected: building the
  // projection reads tabs out of the renderer and is not free.
  if (state.remoteTransport) {
    const { pushWorktreeState } = await import('../remote/handlers/worktree')
    for (const repoPath of repos) {
      try {
        await pushWorktreeState(repoPath)
      } catch (err) {
        warn('worktree state push failed during freshness poll', {
          repo_path: repoPath,
          error: String(err),
        })
      }
    }
  }

  debug('freshness tick complete', { repo_count: repos.length })
}

/**
 * Start the freshness poll. Idempotent — a second call restarts one timer.
 *
 * Gated on attention (`focusState.focused`), which is true when a window has
 * focus OR a paired device is connected. An unattended desktop does no git work
 * at all; the tick after attention returns re-reads everything, and because the
 * inventory cache TTL is the tick period, that read is a fresh crawl rather
 * than a stale cached answer.
 */
export function startWorktreeFreshnessPoll(): void {
  stopWorktreeFreshnessPoll()
  const tick = async (): Promise<void> => {
    if (!focusState.focused) {
      debug('tick skipped, nothing is watching')
      return
    }
    if (ticking) {
      // A crawl took longer than the period. Skipping is correct: the next tick
      // is 5 seconds away and queuing them is how the original spawn storm
      // built up.
      log('tick skipped, previous tick still running')
      return
    }
    ticking = true
    try {
      await pollWorktreeFreshnessOnce()
    } catch (err) {
      // A failed tick must be visible; a silent catch here would make the
      // whole poll look alive while it did nothing.
      warn('freshness tick failed', { error: String(err) })
    } finally {
      ticking = false
    }
  }
  // setInterval must not receive an async function (no-misused-promises).
  timer = setInterval(() => { void tick() }, FRESHNESS_POLL_MS)
  log('freshness poll started', { period_ms: FRESHNESS_POLL_MS })
}

export function stopWorktreeFreshnessPoll(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  ticking = false
  log('freshness poll stopped')
}
