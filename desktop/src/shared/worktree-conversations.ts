/**
 * worktree-conversations — "which conversations live in this directory", "which
 * one does the next click go to", and "which terminal belongs to it".
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
 * ── Conversations and terminals are different questions ─────────────────────
 * A directory can hold both, and they are never interchangeable: a conversation
 * is something to talk to, a terminal is a shell. `collectDirConversations`
 * therefore SKIPS terminal-only tabs and `pickDirTerminal` is the only function
 * that returns one. Keeping both rules here is what stops a surface from
 * answering one question with the other — which is exactly the defect the skip
 * in `collectDirConversations` fixes.
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
  /**
   * True for a terminal-only tab, which is NOT a conversation — see
   * `collectDirConversations`. Optional so a caller that has no terminal tabs
   * to describe (a test fixture, a projection of conversations only) still fits
   * structurally; absent reads as false.
   */
  isTerminalOnly?: boolean
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
 *
 * **Terminal-only tabs are not conversations and are skipped.** A terminal in a
 * worktree or bench directory used to be counted as an open conversation by
 * every consumer of this function at once: it appeared in the hover card
 * (`WorktreeConversationsCard`), inflated the `open ×N` row and bench labels
 * (`describeOpenConversations`), rode the iOS `openConversations` projection,
 * and — worst — was a rotation target for `pickNextConversation`, so the git
 * panel's "go to conversation" could land the operator in a shell. Terminals in
 * these directories are resolved by `pickDirTerminal` instead, which is the
 * only function here that wants them.
 */
export function collectDirConversations(
  tabs: readonly DirConversationSource[],
  dirPath: string,
): DirConversation[] {
  if (!dirPath) return []
  const out: DirConversation[] = []
  tabs.forEach((tab, i) => {
    if (tab.workingDirectory !== dirPath) return
    if (tab.isTerminalOnly) return
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
 * Never names a TAB NUMBER. The hint used to read "open in tab 3", which cited
 * an index no surface in the app displays -- the tab strip shows titles and
 * pills, so the operator had no way to act on the number. It also became wrong
 * the moment tabs were reordered. The count is the part that is both true and
 * usable, and the hover card lists the conversations by name for the rest.
 *
 * Empty → null, so the caller renders nothing at all rather than an empty pill.
 */
export function describeOpenConversations(matches: readonly DirConversation[]): string | null {
  if (matches.length === 0) return null
  if (matches.length === 1) return 'open'
  return `open ×${matches.length}`
}

/**
 * The title Ion gives a bench's dedicated terminal tab.
 *
 * One function names the tab so the picker and the creator cannot disagree:
 * `pickDirTerminal` matches on this string and `openBenchTerminal` writes it.
 * If they were two literals, a change to one would silently orphan every
 * existing bench terminal — the next click would create a second one.
 *
 * Deliberately the same string the bench hover card already uses as its
 * heading, so the tab and the panel name the bench identically.
 */
export function benchTerminalTitle(sourceBranch: string): string {
  return `Bench · ${sourceBranch}`
}

/**
 * The terminal tab that belongs to `dirPath`, or null when there is none.
 *
 * ── Why derivation rather than a stored tab id ───────────────────────────────
 * A bench path is unique per `(repo, sourceBranch)` (`benchPathFor`), so a
 * terminal-only tab in that directory IS that bench's terminal. That makes the
 * identity a property of state the tab already persists (`isTerminalOnly`,
 * `workingDirectory`, `customTitle` all survive restart), so it needs no id
 * written into the workspace record — an id there would be a second source of
 * truth that goes stale the moment the operator closes the tab, and would still
 * need this rule as its fallback.
 *
 * ── Two tiers, and why ──────────────────────────────────────────────────────
 * 1. The terminal whose `customTitle` is `preferredTitle`. This is the tab Ion
 *    named itself, and it wins over tab order so an unrelated shell the operator
 *    happened to open in the same directory first cannot capture the slot.
 * 2. Otherwise the first terminal-only tab in the directory. This adopts a
 *    pre-existing untitled shell instead of opening a second one beside it, and
 *    it keeps an operator RENAME from orphaning the tab: a renamed bench
 *    terminal still matches tier 2, so the button keeps finding it.
 *
 * Returns the source record rather than a `DirConversation` so the caller can
 * read `customTitle` and decide whether to name the tab — the adopt-and-name
 * path needs to tell "Ion named this" from "the operator named this".
 */
export function pickDirTerminal<T extends DirConversationSource>(
  tabs: readonly T[],
  dirPath: string,
  preferredTitle?: string,
): T | null {
  // Same guard as `collectDirConversations`: "no directory" is not a place, so
  // an empty path must never match the tabs that have no directory set.
  if (!dirPath) return null
  const inDir = tabs.filter((t) => t.isTerminalOnly && t.workingDirectory === dirPath)
  if (inDir.length === 0) return null
  if (preferredTitle) {
    const named = inDir.find((t) => t.customTitle === preferredTitle)
    if (named) return named
  }
  return inDir[0]
}
