import React, { useState, useCallback } from 'react'
import type { TabState } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { RenameTabWorktreeDialog } from '../components/RenameTabWorktreeDialog'
import { rError } from '../rendererLogger'

/**
 * The "rename tab and worktree" verb, mounted wherever the tab context menu is.
 *
 * ── Why a hook and not three copies ─────────────────────────────────────────
 * The tab context menu is hosted at three call sites (the tab strip, the group
 * pill, and the group-picker dropdown). Each needs the same three things: the
 * menu handler, the open/closed state, and the dialog itself. Three copies of
 * that wiring is three chances for one site to drift — one forgetting to clear
 * state on cancel, another passing a different default name. So the whole verb
 * lives here and each site spends two lines on it.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 * It does not synchronize anything. The dialog applies one name to both records
 * once, through `renameTabAndWorktree`, and then they are independent again.
 * There is no listener, no propagation, and no ongoing link — renaming a tab by
 * any other path still leaves its worktree alone, which is the intended
 * behaviour.
 *
 * Returns `null` for `dialog` when nothing is open, so a caller can render it
 * unconditionally.
 */
export function useRenameTabWorktree(): {
  /** Open the dialog for a tab. A tab with no worktree is ignored. */
  requestRename: (tab: TabState) => void
  /** The dialog element, or null when closed. Render this unconditionally. */
  dialog: React.ReactElement | null
} {
  const [target, setTarget] = useState<TabState | null>(null)

  const requestRename = useCallback((tab: TabState) => {
    // The menu item is gated on tab.worktree, but re-check rather than trusting
    // the caller: opening this for a plain tab would offer to rename a worktree
    // that does not exist.
    if (!tab.worktree) return
    setTarget(tab)
  }, [])

  const dialog = target
    ? (
        <RenameTabWorktreeDialog
          key="rename-tab-worktree"
          defaultTitle={target.customTitle || target.title}
          worktreeLabel={target.worktree?.branchName ?? ''}
          onSubmit={(title) => {
            const tabId = target.id
            setTarget(null)
            void useSessionStore.getState()
              .renameTabAndWorktree(tabId, title)
              .catch((err) => rError('tabs', 'rename tab and worktree failed', {
                tab_id: tabId.slice(0, 8), error: String(err),
              }))
          }}
          onCancel={() => setTarget(null)}
        />
      )
    : null

  return { requestRename, dialog }
}
