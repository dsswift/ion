/**
 * The single renderer entry point for "this tab's working directory changed".
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * A tab's working directory lives in two places: the renderer's `TabState` (what
 * the UI shows and what send-slice puts on every prompt) and the engine session
 * itself (pinned at `start_session`; only a restart-in-place moves it). Patching
 * one without the other is the defect that put five worktree conversations in
 * one shared checkout.
 *
 * Before this helper, every caller that changed a directory patched ONLY
 * renderer state — `setupWorktree`, `convertToWorktree`, the `setBaseDirectory`
 * worktree follow-up — and `relocateTabSession`, the main-process primitive
 * built precisely to move a live conversation, had zero callers anywhere in the
 * renderer. The mechanism existed and nothing used it.
 *
 * So: one function does both halves, and callers are expected to use it rather
 * than hand-patching `workingDirectory`. Doing both in one place is what keeps
 * them from drifting apart again.
 *
 * ── Relationship to the main-process reconciler ─────────────────────────────
 * `engine-control-plane-cwd.ts` reconciles a divergence on the next prompt, so a
 * caller that forgets this helper is no longer silently broken. That reconciler
 * is the safety net; this helper is the correct path. Both exist deliberately:
 * the net catches mistakes, but relocating at the moment of the change means the
 * session is already right when the operator's next prompt arrives, rather than
 * being fixed by a restart mid-prompt.
 */
import type { TabState } from '../../../shared/types'
import type { StoreSet, StoreGet } from '../session-store-types'
import { rInfo, rWarn } from '../../rendererLogger'

/**
 * Point `tabId` at `dir`, in both the renderer store and the live engine
 * session.
 *
 * `patch` carries any additional TabState fields that belong to the same
 * logical change (`worktree`, `pendingWorktreeSetup`, …) so the directory and
 * its metadata land in a single store update rather than two renders.
 *
 * The store patch is applied FIRST and unconditionally: the UI must reflect the
 * operator's action even if the engine relocation fails, and send-slice reads
 * `workingDirectory` from the store, so a subsequent prompt carries the new
 * directory and the main-process reconciler corrects the session on its own.
 *
 * Returns true when the engine session was relocated successfully. Callers that
 * are about to destroy the old directory (retire) should check it; callers
 * merely attaching a worktree can ignore it, since the reconciler backstops.
 */
export async function setTabWorkingDirectory(
  set: StoreSet,
  get: StoreGet,
  tabId: string,
  dir: string,
  patch?: Partial<TabState>,
): Promise<boolean> {
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab) {
    rWarn('tab.workdir', 'unknown tab; nothing to repoint', { tab_id: tabId.slice(0, 8), dir })
    return false
  }

  const from = tab.workingDirectory
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch, workingDirectory: dir } : t)),
  }))

  // A tab with no conversation yet has no session to move; the directory it was
  // just given is what its first start will use.
  if (!tab.conversationId) {
    rInfo('tab.workdir', 'repointed a tab with no live conversation', {
      tab_id: tabId.slice(0, 8), from, to: dir,
    })
    return true
  }

  try {
    const result = await window.ion.relocateTabSession(tabId, dir)
    if (!result.ok) {
      // Not fatal: the store already carries the new directory, so the next
      // prompt reconciles the session in the main process. Logged at warn
      // because a relocation that had to fall back to the reconciler means the
      // session ran in the old directory for longer than intended.
      rWarn('tab.workdir', 'engine relocation failed; the next prompt will reconcile', {
        tab_id: tabId.slice(0, 8), from, to: dir, error: result.error ?? 'unknown',
      })
      return false
    }
    rInfo('tab.workdir', 'repointed tab and relocated its live conversation', {
      tab_id: tabId.slice(0, 8),
      from,
      to: dir,
      conversation_id: result.conversationId ?? '',
    })
    return true
  } catch (err) {
    rWarn('tab.workdir', 'engine relocation threw; the next prompt will reconcile', {
      tab_id: tabId.slice(0, 8), from, to: dir, error: String(err),
    })
    return false
  }
}
