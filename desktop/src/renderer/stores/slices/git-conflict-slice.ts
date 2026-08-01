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
 * `openConflictAssist` is ONE store action (ATV multi-step rule): create a
 * FRESH conversation in the conflicted directory, then submit the fixed
 * prompt. Always a new tab — commandeering an existing conversation would
 * interrupt it and let its context sway the fix. A component handler chaining
 * these calls would run in whichever window hosts it and decide against stale
 * mirror state.
 *
 * The assist requires the `standard` model tier (CONFLICT_ASSIST_TIER) and
 * refuses with a remediation message when it is not configured. The fresh
 * conversation is pinned to that tier's model and forced into auto mode —
 * a plan-mode default would park the fix writing a plan.
 */
import type { StoreSet, StoreGet, State, GitConflictAlert } from '../session-store-types'
import { rInfo, rDebug, rWarn } from '../../rendererLogger'
import { applyPermissionModeForTab } from './tab-slice-permission-mode'

/** The exact prompt the AI Assisted button sends. Verbatim by specification. */
export const CONFLICT_ASSIST_PROMPT = 'Please fix my currently in-progress rebase.'

/**
 * The model tier the assist runs on. A rebase fix is bounded, mechanical work:
 * the operator's default is often a reasoning model, which is slower and more
 * expensive than this task warrants, and the highest/lowest tiers are the
 * wrong axis. The `standard` tier from ~/.ion/models.json is the deliberate
 * choice, and the assist REFUSES when it is not configured rather than
 * silently running on some other model.
 */
export const CONFLICT_ASSIST_TIER = 'standard'

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
     * AI Assisted resolution: a FRESH conversation in the conflicted
     * directory with the fixed prompt.
     *
     * Always a new tab, never a focused existing one. The first version
     * focused an existing conversation in the directory (the bench-conversation
     * re-entry pattern), which was wrong twice over: submitting into a live
     * development conversation interrupts it mid-thread, and the accumulated
     * context can sway how the model resolves the rebase. The fix needs a
     * clean context whose entire instruction is the one prompt. The operator's
     * development conversation stays untouched.
     */
    openConflictAssist: async (directory) => {
      // ── Gate: the standard tier must be configured ─────────────────────
      // Resolved through the engine (it owns models.json semantics), before
      // any tab exists, so a refusal creates nothing to clean up.
      const tier = await window.ion.resolveModelTier(CONFLICT_ASSIST_TIER)
      if (!tier.configured) {
        rWarn('git.conflicts', 'assist refused: model tier not configured', {
          directory,
          tier: CONFLICT_ASSIST_TIER,
        })
        throw new Error(
          `AI Assisted resolution needs a "${CONFLICT_ASSIST_TIER}" model tier. ` +
          `Add one under "tiers" in ~/.ion/models.json (e.g. "standard": "<provider>/<model>") and try again.`,
        )
      }

      rInfo('git.conflicts', 'assist: opening fresh conversation in conflicted directory', {
        directory,
        model: tier.model,
      })
      // useWorktree=false: the directory IS the checkout to fix; a nested
      // worktree would point the conversation somewhere else entirely.
      // skipDuplicateCheck=true: a blank tab reuse is fine, but an existing
      // NON-blank conversation must never be commandeered — and the duplicate
      // check's blank-reuse path is only safe because a blank tab has no
      // context to sway the fix. Skipping keeps the guarantee unconditional.
      const tabId = await get().createTabInDirectory(directory, false, true)

      // Pin the tier's model on the fresh conversation. setTabModel writes
      // modelOverride on the active instance, which submit() then sends.
      get().setTabModel(tabId, tier.model)

      // Force auto mode regardless of the operator's default. The assist's
      // whole job is to EXECUTE the rebase fix; a plan-mode default would
      // park it writing a plan for work that was already requested verbatim.
      applyPermissionModeForTab(set, get, tabId, 'auto', 'conflict_assist')

      get().submit(tabId, CONFLICT_ASSIST_PROMPT)
      rInfo('git.conflicts', 'assist prompt submitted', {
        directory,
        tab_id: tabId.slice(0, 8),
        model: tier.model,
      })
      return tabId
    },
  }
}
