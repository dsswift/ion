/**
 * worktree-occupants — "which tabs live inside this directory, and what does a
 * refusal say about the ones that are busy".
 *
 * ── Why this is separate from worktree-conversations.ts ──────────────────────
 * That module answers "which CONVERSATIONS are open in a directory" for the
 * row hint, the hover card, the rotation, and the iOS projection — and it
 * deliberately SKIPS terminal-only tabs, because a terminal is not something to
 * talk to. This module answers a different question: "what would be left
 * pointing at a path that is about to be deleted". A shell whose working
 * directory has just been removed is as broken as a conversation, so terminals
 * are INCLUDED here. Reusing `collectDirConversations` for retire would have
 * silently left every terminal in the worktree alive on a dead path.
 *
 * ── Why containment rather than equality ────────────────────────────────────
 * Three things make `workingDirectory === dirPath` the wrong test for a retire:
 *
 *  1. A tab's `worktree` metadata is best-effort — `newWorktreeConversation`
 *     leaves it null when the registry has no source branch — so the metadata
 *     cannot be the filter either. `workingDirectory` is always set.
 *  2. A tab can sit in a SUBDIRECTORY of the worktree (the operator picked it,
 *     or a base-directory change moved it), and a retire removes the whole
 *     tree.
 *  3. Worktree paths are sibling `<repo>-<hex>` directories in one parent, so a
 *     bare `startsWith` matches `…-a33725460` against `…-a3372546` and would
 *     close a DIFFERENT worktree's tabs.
 *
 * So containment is delegated to `isWithinRepo`, which is the repo's single
 * definition of the separator-required descendant rule. Point 3 is exactly the
 * bug its header documents; this module is its fourth caller and does not
 * restate the rule.
 *
 * Deliberately PURE: plain arrays in, plain data out, no store and no Electron,
 * so the renderer store, the components, and the tests all share one answer.
 */
import { isWithinRepo } from './repo-containment'

/** The minimal tab shape this module needs. Structural, so every caller fits. */
export interface OccupantTab {
  id: string
  title: string
  /** User-provided name; overrides `title` when set. */
  customTitle: string | null
  workingDirectory: string
  /**
   * True for a terminal-only tab. Unlike `collectDirConversations`, terminals
   * are still occupants here (see the header). Optional so a caller with no
   * terminals to describe still fits structurally; absent reads as false.
   */
  isTerminalOnly?: boolean
}

/** One tab that is still doing work, and the reason it counts as active. */
export interface ActiveOccupant {
  tabId: string
  /** Display name, so the operator can find the tab in the strip. */
  title: string
  /** Short phrase: "running", "2 background agents running", etc. */
  reason: string
}

/**
 * Every tab whose working directory is `dirPath` or a path beneath it, in tab
 * order.
 *
 * Returns an empty array for an empty `dirPath` rather than matching every tab
 * that has no directory set — "no directory" is not a place, and treating it as
 * one would make an unrelated tab look like an occupant of the directory about
 * to be deleted.
 */
export function collectOccupants<T extends OccupantTab>(
  tabs: readonly T[],
  dirPath: string,
): T[] {
  if (!dirPath) return []
  return tabs.filter((tab) => isWithinRepo(tab.workingDirectory, dirPath))
}

/**
 * Occupants of several directories at once, de-duplicated by tab id.
 *
 * A retire removes the worktree AND any bench directory the disenrollment
 * empties, so the set of tabs it strands spans several roots. De-duplication
 * matters because those roots can nest in principle, and closing the same tab
 * twice would log a phantom second close.
 */
export function collectOccupantsAcross<T extends OccupantTab>(
  tabs: readonly T[],
  dirPaths: readonly string[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const dirPath of dirPaths) {
    for (const tab of collectOccupants(tabs, dirPath)) {
      if (seen.has(tab.id)) continue
      seen.add(tab.id)
      out.push(tab)
    }
  }
  return out
}

/** Display name for a tab: the operator's name when set, else the title. */
export function occupantTitle(tab: OccupantTab): string {
  return tab.customTitle || tab.title || 'Untitled'
}

/**
 * The refusal the operator reads when a retire is blocked by live work.
 *
 * NAMES every active tab and why it is active. A refusal that only said "this
 * worktree is active" would be unactionable in a workspace with many tabs: the
 * operator has to find the conversation to decide whether to interrupt it or
 * wait, and that decision is theirs to make. Ion refuses and reports; it never
 * interrupts running work on the operator's behalf.
 *
 * Returns the empty string for an empty list so a caller cannot accidentally
 * raise a refusal with nothing in it — the callers treat "no active occupants"
 * as "proceed" and never format a message at all.
 */
export function formatActiveWorktreeRefusal(active: readonly ActiveOccupant[]): string {
  if (active.length === 0) return ''
  const lines = active.map((a) => `• ${a.title} — ${a.reason}`).join('\n')
  const subject = active.length === 1 ? 'this conversation' : 'these conversations'
  return (
    'This worktree still has active work, so it was not retired. ' +
    `Finish or interrupt ${subject} first, then retire it:\n${lines}`
  )
}
