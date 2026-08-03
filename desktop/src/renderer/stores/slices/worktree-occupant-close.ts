/**
 * worktree-occupant-close — the two store-side halves of "retire never deletes
 * a directory out from under live work, and never leaves a tab on a dead path".
 *
 * ── Why this is a module and not inline in the retire action ─────────────────
 * Three call sites need identical behaviour: the row-menu confirmation gate
 * (`WorktreeRowMenu.requestRetire`), the store action every path funnels
 * through (`retireWorktree`), and the land-then-retire flow
 * (`finishWorktreeTab`). A second copy in any of them is a copy that drifts —
 * and the failure mode of drift here is a deleted directory under a running
 * agent, which is unrecoverable. It also keeps `worktree-inventory-slice.ts`
 * under the 600-line cap.
 *
 * ── The ordering rule this file exists to enforce ────────────────────────────
 * `closeTab` REFUSES a busy tab (`evaluateCloseGuard`) and there is
 * deliberately no `force` — forcing would SIGTERM dispatched sub-agents and
 * kill long builds, which is the footgun the guard exists to prevent. So a
 * bulk close cannot be the safety mechanism: it would run its refusals AFTER
 * the directory was gone, leaving a live conversation attached to nothing.
 *
 * The resolution is ordering. `resolveRetireBlockers` runs BEFORE the retire
 * IPC and refuses the whole verb while anything is active; the operator decides
 * whether to interrupt or wait, because that work may matter and that call is
 * not Ion's to make. `closeOccupants` then runs after a successful retire, when
 * the pre-flight has already established there is nothing to protect.
 */
import type { StoreSet, StoreGet } from '../session-store-types'
import { rInfo, rWarn, rDebug } from '../../rendererLogger'
import {
  collectOccupantsAcross,
  formatActiveWorktreeRefusal,
  occupantTitle,
  type ActiveOccupant,
} from '../../../shared/worktree-occupants'
import { evaluateCloseGuard, describeCloseGuardReason, formatCloseGuardRefusal } from './tab-close-guard'
import { setTabWorkingDirectory } from './tab-working-directory'

const TAG = 'worktree.occupants'

/** A refusal: which tabs are active, and the message the operator reads. */
export interface RetireBlockers {
  active: ActiveOccupant[]
  error: string
}

/**
 * Every tab in `dirPaths` that `closeTab` would refuse to close.
 *
 * A terminal-only tab has no `conversationPane`, so `evaluateCloseGuard`
 * returns `blocked: false` for it and a terminal can never block a retire. That
 * is correct: a shell has no orchestrator, no dispatched agents, and no
 * outstanding tool calls to protect — it is closed, not waited on.
 */
export function findActiveOccupants(get: StoreGet, dirPaths: readonly string[]): ActiveOccupant[] {
  const occupants = collectOccupantsAcross(get().tabs, dirPaths)
  const active: ActiveOccupant[] = []
  for (const tab of occupants) {
    const guard = evaluateCloseGuard(get().conversationPanes.get(tab.id))
    if (!guard.blocked) continue
    active.push({
      tabId: tab.id,
      title: occupantTitle(tab),
      reason: describeCloseGuardReason(guard),
    })
    rDebug(TAG, 'occupant is active', {
      tab_id: tab.id.slice(0, 8),
      reason: formatCloseGuardRefusal(tab.id, guard),
    })
  }
  return active
}

/**
 * The retire pre-flight: `null` when the retire may proceed, or the refusal.
 *
 * `benchPaths` are the bench directories the retire would ALSO remove (from
 * `gitWorktreeRetirePreview`). They belong in the same question because a bench
 * directory hosts real conversations and a terminal, and a retire that prunes
 * an empty bench deletes their working directory too.
 *
 * Logs both branches: a refusal at WARN (it is an operator-visible outcome), a
 * clear pre-flight at DEBUG with the occupant count, so the log shows the check
 * ran and what it saw rather than only recording the unhappy path.
 */
export function resolveRetireBlockers(
  get: StoreGet,
  worktreePath: string,
  benchPaths: readonly string[] = [],
): RetireBlockers | null {
  const dirPaths = [worktreePath, ...benchPaths]
  const active = findActiveOccupants(get, dirPaths)
  if (active.length === 0) {
    rDebug(TAG, 'retire pre-flight clear', {
      worktree_path: worktreePath,
      bench_paths: benchPaths.length,
      occupants: collectOccupantsAcross(get().tabs, dirPaths).length,
    })
    return null
  }
  const error = formatActiveWorktreeRefusal(active)
  rWarn(TAG, 'retire refused: active work in the worktree', {
    worktree_path: worktreePath,
    bench_paths: benchPaths.length,
    active_count: active.length,
    active_tabs: active.map((a) => `${a.tabId.slice(0, 8)}:${a.reason}`).join('; '),
  })
  return { active, error }
}

/**
 * Close every tab living in `dirPaths`, because those directories no longer
 * exist.
 *
 * ── Why close rather than relocate ──────────────────────────────────────────
 * This used to relocate the FIRST occupant to the repo root and ignore the
 * rest. Both halves were wrong: `find` left every additional tab pointed at a
 * deleted directory, and relocation is not what retire means. Retire says the
 * work is done or abandoned and its place is gone — there is nothing at the
 * repo root for that conversation to continue, and the re-entry path for new
 * work is a new conversation in a new worktree.
 *
 * ── The relocation fallback, and why it survives ─────────────────────────────
 * `closeTab` can still refuse: an agent may have started in the window between
 * the pre-flight and the removal. Relocating that tab to `fallbackDir` (which
 * also moves its live engine session) is strictly better than leaving it on a
 * dead path, so the fallback stays — but it now covers ONLY that race, not the
 * ordinary case, and it logs at WARN because reaching it means the pre-flight
 * was overtaken.
 */
export async function closeOccupants(
  set: StoreSet,
  get: StoreGet,
  dirPaths: readonly string[],
  fallbackDir?: string,
): Promise<void> {
  const occupants = collectOccupantsAcross(get().tabs, dirPaths)
  if (occupants.length === 0) {
    rDebug(TAG, 'nothing to close for retired directories', { dir_count: dirPaths.length })
    return
  }

  const terminals = occupants.filter((t) => t.isTerminalOnly).length
  rInfo(TAG, 'closing tabs whose directory was retired', {
    dir_count: dirPaths.length,
    total: occupants.length,
    conversations: occupants.length - terminals,
    terminals,
  })

  const closedIds: string[] = []
  for (const tab of occupants) {
    get().closeTab(tab.id)
    // The guard is re-evaluated inside closeTab, so "still present" is the
    // honest test for a refusal rather than trusting the pre-flight's verdict.
    if (get().tabs.some((t) => t.id === tab.id)) {
      if (fallbackDir) {
        rWarn(TAG, 'close refused after retire; relocating off the deleted path', {
          tab_id: tab.id.slice(0, 8), fallback_dir: fallbackDir,
        })
        await setTabWorkingDirectory(set, get, tab.id, fallbackDir, {
          worktree: null,
          pendingWorktreeSetup: false,
        })
      } else {
        rWarn(TAG, 'close refused after retire and no relocation target; tab left on a dead path', {
          tab_id: tab.id.slice(0, 8),
        })
      }
      continue
    }
    closedIds.push(tab.id)
  }

  // A pending close dialog must not outlive its tab: the intent names a tabId
  // that no longer exists, so confirming it would be a close of nothing while
  // the dialog claims to be about a real conversation.
  const intent = get().closeIntent
  if (intent && closedIds.includes(intent.tabId)) {
    rDebug(TAG, 'clearing close intent for a tab closed by retire', { tab_id: intent.tabId.slice(0, 8) })
    set({ closeIntent: null })
  }

  rInfo(TAG, 'retired-directory tabs closed', { closed: closedIds.length, requested: occupants.length })
}
