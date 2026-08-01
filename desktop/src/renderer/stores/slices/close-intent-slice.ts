/**
 * close-intent slice — the single confirm surface for closing a conversation.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Closing a tab used to confirm two different ways. The pill's X flipped to an
 * inline Yes/No inside the pill (~40px, no room for a sentence); Cmd+W raised
 * `CloseTabConfirmDialog`. Two surfaces meant two behaviours for one verb, and
 * the narrow one could not carry the thing the operator most needs to know:
 * that a worktree conversation is being closed on top of work that has not
 * landed.
 *
 * Every close request now routes through `requestCloseTab`, which resolves the
 * warning BEFORE the dialog renders and parks the result in `closeIntent`. Any
 * entry point (pill X, group pill, middle-click, Cmd+W, a future one) raises
 * the same dialog by calling one action, so a new entry point cannot
 * accidentally ship a third confirm behaviour.
 *
 * ── Why the appraisal is awaited before the dialog opens ─────────────────────
 * desktop/AGENTS.md § "View readiness principle": a view is complete the moment
 * it renders. A dialog that opens and then grows a warning line a beat later
 * would be exactly the "badge shows 1, then 3" defect — and worse here, because
 * the operator may have already clicked Close by the time the warning arrives.
 * So `requestCloseTab` is async and `closeIntent` is set once, fully resolved.
 *
 * ── Guard interaction ───────────────────────────────────────────────────────
 * The running-work guard is evaluated here too, so a blocked tab never even
 * opens a dialog the user would then be refused by. `closeTab` re-evaluates it
 * — this is a UX short-circuit, not the enforcement point.
 */
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { rInfo, rWarn, rDebug } from '../../rendererLogger'
import { decideWorktreeClose } from '../../../shared/worktree-close-decision'
import { evaluateCloseGuard, formatCloseGuardRefusal } from './tab-close-guard'

export function createCloseIntentSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    closeIntent: null,

    requestCloseTab: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) {
        rDebug('tab.close', 'close requested for unknown tab', { tab_id: tabId.slice(0, 8) })
        return
      }

      // Short-circuit a tab the guard would refuse anyway, so the operator gets
      // the refusal in the log rather than a dialog that does nothing.
      const guard = evaluateCloseGuard(get().conversationPanes.get(tabId))
      if (guard.blocked) {
        rWarn('tab.close', 'close request refused by guard', {
          tab_id: tabId, reason: formatCloseGuardRefusal(tabId, guard),
        })
        return
      }

      const base = {
        tabId,
        title: tab.customTitle || tab.title || 'Untitled',
        directory: tab.workingDirectory,
      }

      // A plain conversation has no second lifetime to warn about: closing it
      // leaves nothing behind on disk that the operator needs told about.
      if (!tab.worktree) {
        set({ closeIntent: { ...base, warning: null } })
        rDebug('tab.close', 'close intent raised', { tab_id: tabId.slice(0, 8), worktree: false })
        return
      }

      const { worktreePath, sourceBranch, branchName } = tab.worktree
      // The appraisal is read fresh rather than from the inventory cache: the
      // inventory refreshes on a timer, and "did I leave uncommitted work" must
      // answer for the tree as it is at the moment of closing, not as it was at
      // the last poll.
      let appraisal = null
      try {
        appraisal = await window.ion.gitWorktreeAppraise(worktreePath, sourceBranch)
      } catch (err) {
        // A failed appraisal is NOT silently treated as "nothing to warn about"
        // — decideWorktreeClose fails closed on null and warns that the
        // contents could not be verified.
        rWarn('tab.close', 'worktree appraisal failed; warning conservatively', {
          tab_id: tabId.slice(0, 8), worktree_path: worktreePath, error: String(err),
        })
      }

      const decision = decideWorktreeClose(worktreePath, appraisal)
      set({ closeIntent: { ...base, warning: decision.shouldWarn ? (decision.summary ?? null) : null } })
      rInfo('tab.close', 'close intent raised for worktree conversation', {
        tab_id: tabId.slice(0, 8),
        worktree_path: worktreePath,
        branch: branchName,
        should_warn: decision.shouldWarn,
        unlanded: appraisal?.unlandedCommitCount ?? -1,
        uncommitted: appraisal?.uncommittedPaths.length ?? -1,
        appraisal_failed: appraisal === null || appraisal.appraisalFailed === true,
      })
    },

    confirmCloseTab: () => {
      const intent = get().closeIntent
      if (!intent) {
        rDebug('tab.close', 'confirm with no pending close intent')
        return
      }
      rInfo('tab.close', 'close confirmed', { tab_id: intent.tabId.slice(0, 8), warned: intent.warning !== null })
      set({ closeIntent: null })
      get().closeTab(intent.tabId)
    },

    cancelCloseTab: () => {
      const intent = get().closeIntent
      if (!intent) return
      rDebug('tab.close', 'close cancelled', { tab_id: intent.tabId.slice(0, 8), warned: intent.warning !== null })
      set({ closeIntent: null })
    },
  }
}
