/**
 * Git conflict alerts — the store model behind "a sync failed and you need to
 * know".
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A conflicted sync used to fail into the log file and nowhere else: the
 * result carried `hasConflicts: true` and an operator-facing message, and the
 * UI discarded both. The operator pressed "Sync from josh", saw nothing, and
 * reasonably believed it succeeded — while the worktree sat mid-rebase with
 * its work invisible. This slice is where that signal becomes visible state.
 *
 * ── Sources ─────────────────────────────────────────────────────────────────
 * Alerts are keyed by DIRECTORY (the checkout that is conflicted), fed by:
 *   - sync/land results with `hasConflicts` (recorded by syncWorktree and the
 *     land path the moment they fail);
 *   - inventory refreshes that find a worktree with `operationState` set
 *     (covers a conflict that happened outside Ion, or before a restart).
 *
 * An alert clears when the directory's operation completes or aborts — the
 * inventory refresh notices `operationState` is gone — or when the operator
 * dismisses the toast. Dismissing hides the TOAST only; the row badge and
 * panel banner derive from live inventory state, not from this map, so the
 * truth stays visible until the conflict is actually resolved.
 *
 * ── AI Assisted ─────────────────────────────────────────────────────────────
 * `openConflictAssist` is ONE store action (ATV multi-step rule): focus an
 * existing conversation in the conflicted directory or create one, then submit
 * the fixed prompt. A component handler chaining these calls would run in
 * whichever window hosts it and decide against stale mirror state.
 */
import type { StoreSet, StoreGet, State, GitConflictAlert } from '../session-store-types'
import { rInfo, rDebug } from '../../rendererLogger'

/** The exact prompt the AI Assisted button sends. Verbatim by specification. */
export const CONFLICT_ASSIST_PROMPT = 'Please fix my currently in-progress rebase.'

export function createGitConflictSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    /**
     * Record that a directory is conflicted. Called from the sync/land failure
     * paths (source 'sync' / 'land') and from inventory refreshes that find an
     * in-progress operation (source 'detected').
     *
     * Re-recording the same directory updates the message but keeps the alert
     * un-dismissed only if it was not already dismissed — a poll must not
     * resurrect a toast the operator closed.
     */
    recordConflictAlert: (directory, alert) => {
      set((s) => {
        const existing = s.gitConflictAlerts.get(directory)
        const next: GitConflictAlert = {
          ...alert,
          // A fresh sync/land failure is new information and re-raises the
          // toast; a periodic 'detected' record keeps a prior dismissal.
          dismissed: alert.source === 'detected' ? (existing?.dismissed ?? false) : false,
          recordedAt: Date.now(),
        }
        rInfo('git.conflicts', 'conflict alert recorded', {
          directory,
          source: alert.source,
          operation: alert.operationState ?? '',
          re_raised: !next.dismissed,
        })
        return { gitConflictAlerts: new Map(s.gitConflictAlerts).set(directory, next) }
      })
    },

    /** Drop a directory's alert entirely — its operation completed or aborted. */
    clearConflictAlert: (directory) => {
      set((s) => {
        if (!s.gitConflictAlerts.has(directory)) return {}
        rDebug('git.conflicts', 'conflict alert cleared', { directory })
        const next = new Map(s.gitConflictAlerts)
        next.delete(directory)
        return { gitConflictAlerts: next }
      })
    },

    /** Hide the toast for a directory. The row badge stays until resolved. */
    dismissConflictAlert: (directory) => {
      set((s) => {
        const existing = s.gitConflictAlerts.get(directory)
        if (!existing || existing.dismissed) return {}
        rDebug('git.conflicts', 'conflict toast dismissed', { directory })
        return {
          gitConflictAlerts: new Map(s.gitConflictAlerts)
            .set(directory, { ...existing, dismissed: true }),
        }
      })
    },

    /**
     * AI Assisted resolution: a conversation in the conflicted directory with
     * the fixed prompt. Focuses an existing conversation there first (the
     * bench-conversation pattern) so the assist lands in the operator's
     * context instead of stacking a duplicate tab.
     */
    openConflictAssist: async (directory) => {
      const existing = get().tabs.find((t) => t.workingDirectory === directory)

      let tabId: string
      if (existing) {
        rInfo('git.conflicts', 'assist: focusing existing conversation', {
          directory,
          tab_id: existing.id.slice(0, 8),
        })
        get().selectTab(existing.id)
        tabId = existing.id
      } else {
        rInfo('git.conflicts', 'assist: opening conversation in conflicted directory', { directory })
        // useWorktree=false: the directory IS the checkout to fix; a nested
        // worktree would point the conversation somewhere else entirely.
        tabId = await get().createTabInDirectory(directory, false, true)
      }

      get().submit(tabId, CONFLICT_ASSIST_PROMPT)
      rInfo('git.conflicts', 'assist prompt submitted', { directory, tab_id: tabId.slice(0, 8) })
      return tabId
    },
  }
}
