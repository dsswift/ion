/**
 * worktree-conversations — "which conversations live in this directory", and
 * "which one does the next click go to".
 *
 * ── Why this is one shared module ───────────────────────────────────────────
 * Three surfaces need the same answer and used to each compute their own:
 * the git-panel worktree rows (`tabs.findIndex(...)`, which found only the
 * FIRST match and so hid every additional conversation), the store action that
 * opens or focuses a worktree conversation (`tabs.find(...)`, which re-selected
 * the same tab on every click, forever), and the iOS projection (a single
 * `openTabId`). Three implementations of one fact is how the surfaces disagree.
 *
 * So: one collector, one rotation rule, consumed by the renderer store, the
 * components, and the main-process remote projection alike. It lives in
 * `shared/` because both the renderer and the main process import it, and it is
 * deliberately PURE — it takes a plain array of tab-shaped records and returns
 * plain data, so it is trivially testable and carries no store or Electron
 * dependency.
 *
 * ── Rotation is stateless by design ─────────────────────────────────────────
 * `pickNextConversation` derives the next target from the CURRENTLY ACTIVE tab
 * rather than from a stored cursor. That is not a shortcut, it is the correct
 * mechanism: each click makes its target active, so the next click naturally
 * advances. A stored cursor would be a second source of truth that the overlay
 * and the ATV mirror could disagree about (each window would keep its own),
 * and it would go stale the moment a tab is closed out from under it.
 */

/** The minimal tab shape this module needs. Structural, so every caller fits. */
export interface DirConversationSource {
  id: string
  title: string
  /** User-provided name; overrides `title` when set. */
  customTitle: string | null
  status: string
  workingDirectory: string
}

/** One conversation open in a directory, as every surface renders it. */
export interface DirConversation {
  tabId: string
  /** Display name: the custom title when the operator set one, else the title. */
  title: string
  status: string
  /**
   * 1-based position in the FULL tab list — the same number the row hint has
   * always shown ("open in tab 3"). Deliberately the global index rather than
   * an index within the match list: the operator counts tabs in the tab strip,
   * not within a worktree.
   */
  index: number
}

/**
 * Every conversation whose working directory is `dirPath`, in tab order.
 *
 * Returns an empty array for an empty `dirPath` rather than matching every tab
 * that has no directory set — "no directory" is not a place, and treating it as
 * one would make an unrelated home-directory tab look like a worktree occupant.
 */
export function collectDirConversations(
  tabs: readonly DirConversationSource[],
  dirPath: string,
): DirConversation[] {
  if (!dirPath) return []
  const out: DirConversation[] = []
  tabs.forEach((tab, i) => {
    if (tab.workingDirectory !== dirPath) return
    out.push({
      tabId: tab.id,
      title: tab.customTitle || tab.title,
      status: tab.status,
      index: i + 1,
    })
  })
  return out
}

/**
 * The conversation a click should land on: the one AFTER the active tab,
 * wrapping at the end.
 *
 * - Active tab is one of the matches → the next match (wrapping).
 * - Active tab is not a match (the operator is elsewhere) → the first match,
 *   because "take me to this worktree" means the front of the list, not an
 *   arbitrary position left over from a previous visit.
 * - No matches → null; the caller creates a conversation instead.
 */
export function pickNextConversation(
  matches: readonly DirConversation[],
  activeTabId: string | null,
): DirConversation | null {
  if (matches.length === 0) return null
  const current = activeTabId
    ? matches.findIndex((c) => c.tabId === activeTabId)
    : -1
  if (current < 0) return matches[0]
  return matches[(current + 1) % matches.length]
}

/**
 * The row hint for a set of open conversations.
 *
 * One representation of the fact, not two: a single conversation names the tab
 * the operator can jump to, several name the count, because "open in tab 3"
 * when three are open states something true about one of them and false about
 * the row. Empty → null, so the caller renders nothing at all.
 */
export function describeOpenConversations(matches: readonly DirConversation[]): string | null {
  if (matches.length === 0) return null
  if (matches.length === 1) return `open in tab ${matches[0].index}`
  return `open in ${matches.length} tabs`
}
