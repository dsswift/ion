/**
 * WorktreeRowMenu items — the menu's verb list, derived from worktree state.
 *
 * Extracted from WorktreeRowMenu.tsx to keep both files under the 600-line
 * cap. This module owns WHAT the verbs are and when each is available; the
 * component owns the operations they invoke and the dialogs they raise. The
 * split is along that seam deliberately: everything here is a pure derivation
 * from the entry, the bench membership, and a set of callbacks, so the item
 * list can be reasoned about (and tested) without mounting a portal.
 */
import React from 'react'
import { ArrowLineDown, ArrowsClockwise, Bug, ChatCircle, Check, Flask, FolderOpen, Package, PencilSimple, Trash } from '@phosphor-icons/react'
import { describeLandStrategy } from '../../shared/worktree-land-strategy'
import type { ColorPalette } from '../theme/palette-dark'
import type { IntegrationMember, WorktreeInventoryEntry } from '../../shared/types'
import type { WorktreeCompletionStrategy } from '../../shared/types'

/**
 * One row in the menu.
 *
 * `keepsMenuOpen` is the single opt-out from uniform dismissal, for items that
 * REPLACE the menu body with their own UI rather than dismissing it. Rename
 * swaps in an inline editor; land and retire own dialogs that are children of
 * the menu component and would unmount with it.
 */
export interface WorktreeMenuItem {
  label: string
  icon: React.ReactNode
  disabled?: boolean
  hint?: string
  /** Item renders its own UI in place of the menu; it handles its own exit. */
  keepsMenuOpen?: boolean
  run(): void
}

/**
 * The operations the menu can invoke. Supplied by the component so this module
 * stays free of store access, IPC, and dialog state.
 */
export interface WorktreeMenuActions {
  onNewConversation(): void
  onBeginRename(): void
  onAddToBench(): void
  onSetReview(verdict: 'good' | 'issue' | null): void
  onMoveInBench(toIndex: number): void
  onSync(): void
  onLand(): void
  onReveal(): void
  onReprovision(): void
  onRequestRetire(): void
}

export interface WorktreeMenuItemsInput {
  entry: WorktreeInventoryEntry
  colors: ColorPalette
  strategy: WorktreeCompletionStrategy
  /** Bench membership for this worktree, when it is enrolled in one. */
  enrolled: { membership: IntegrationMember; sourceBranch: string } | undefined
  /** Position of this worktree in its bench's merge order; -1 when unenrolled. */
  benchIndex: number
  /** Number of members in this worktree's bench; 0 when unenrolled. */
  benchSize: number
  /** True when this worktree is already a member of any bench for the repo. */
  alreadyInBench: boolean
  actions: WorktreeMenuActions
}

/**
 * Why the land verb is unavailable, or '' when it is available.
 *
 * Without a known source branch land is unanswerable: git does not record what
 * a worktree was cut from, and guessing would land work in the wrong branch.
 * Disable rather than guess.
 */
export function landRefusalReason(entry: WorktreeInventoryEntry): string {
  if (!entry.sourceBranch) return 'Source branch unknown'
  if (entry.isDirty) return 'Commit changes first'
  if (entry.unlandedCommitCount === 0) return 'Nothing to land'
  return ''
}

/** True when the land verb can run against this worktree. */
export function canLandWorktree(entry: WorktreeInventoryEntry): boolean {
  return !!entry.sourceBranch && entry.unlandedCommitCount > 0 && !entry.isDirty
}

/**
 * Build the menu's verbs.
 *
 * ── Dismissal is uniform and declared here, not inside each handler ────────
 * Clicking an enabled item ALWAYS withdraws the menu immediately, before the
 * verb runs. That was previously each handler's own business, and the seven
 * items had four different behaviours: sync and reveal closed immediately,
 * add-to-bench and re-provision closed only after their await resolved (so
 * the menu sat open for the duration), land never closed at all on success,
 * and retire waited on the appraisal round-trip before its dialog replaced
 * the menu. A menu still on screen after a click reads as "the click did
 * nothing" — which is exactly what was reported for retire.
 */
export function buildWorktreeMenuItems(input: WorktreeMenuItemsInput): WorktreeMenuItem[] {
  const { entry, colors, strategy, enrolled, benchIndex, benchSize, alreadyInBench, actions } = input
  const canLand = canLandWorktree(entry)
  const landReason = landRefusalReason(entry)

  return [
    {
      // The row CLICK opens or cycles existing conversations; this creates an
      // additional one. Two distinct verbs, so the second gets a menu entry
      // rather than a second gutter button that looks like the first.
      label: 'New conversation here',
      icon: <ChatCircle size={12} color={colors.accent} />,
      run: actions.onNewConversation,
    },
    {
      label: entry.title ? 'Rename worktree' : 'Name this worktree',
      icon: <PencilSimple size={12} color={colors.textSecondary} />,
      // Named lazily from the first prompt, so a worktree that has not been
      // prompted in yet still needs a manual way to get a name.
      hint: entry.title ? '' : 'Not named yet',
      // Swaps the menu body for the inline editor.
      keepsMenuOpen: true,
      run: actions.onBeginRename,
    },
    {
      label: alreadyInBench ? 'Already in the bench' : 'Add to integration bench',
      icon: <Flask size={12} color={alreadyInBench || !entry.sourceBranch ? colors.textTertiary : colors.accent} />,
      disabled: alreadyInBench || !entry.sourceBranch,
      hint: !entry.sourceBranch ? 'Source branch unknown' : '',
      run: actions.onAddToBench,
    },
    // Review verdicts. These live in the row's state slot only when nothing more
    // urgent needs it, so the menu is where they are always reachable -- and
    // where a verdict can be cleared by selecting the one already set.
    ...(enrolled ? [
      {
        label: enrolled.membership.review === 'good' ? 'Clear reviewed good' : 'Mark reviewed good',
        icon: <Check size={12} color={enrolled.membership.review === 'good' ? colors.worktreeGreen : colors.textSecondary} />,
        run: () => { actions.onSetReview(enrolled.membership.review === 'good' ? null : 'good') },
      },
      {
        label: enrolled.membership.review === 'issue' ? 'Clear review issue' : 'Mark review issue',
        icon: <Bug size={12} color={enrolled.membership.review === 'issue' ? colors.dangerFg : colors.textSecondary} />,
        run: () => { actions.onSetReview(enrolled.membership.review === 'issue' ? null : 'issue') },
      },
      // Keyboard-reachable reorder. Dragging the rail is the direct gesture, but
      // a drag is not available to every operator or every input device.
      {
        label: 'Move earlier in the merge',
        icon: <ArrowLineDown size={12} color={colors.textSecondary} style={{ transform: 'rotate(180deg)' }} />,
        disabled: benchIndex <= 0,
        hint: benchIndex <= 0 ? 'Already first' : '',
        run: () => { actions.onMoveInBench(benchIndex - 1) },
      },
      {
        label: 'Move later in the merge',
        icon: <ArrowLineDown size={12} color={colors.textSecondary} />,
        disabled: benchIndex < 0 || benchIndex >= benchSize - 1,
        hint: benchIndex >= benchSize - 1 ? 'Already last' : '',
        run: () => { actions.onMoveInBench(benchIndex + 1) },
      },
    ] : []),
    {
      label: `Sync from ${entry.sourceBranch ?? 'source'}`,
      icon: <ArrowsClockwise size={12} color={colors.textSecondary} />,
      disabled: !entry.sourceBranch || entry.isDirty,
      hint: !entry.sourceBranch ? 'Source branch unknown' : entry.isDirty ? 'Commit changes first' : '',
      run: actions.onSync,
    },
    {
      label: `Land into ${entry.sourceBranch ?? 'source'}`,
      icon: <ArrowLineDown size={12} color={canLand ? colors.worktreeGreen : colors.textTertiary} />,
      disabled: !canLand,
      // Name the strategy that will actually run, so the operator is not
      // guessing which of the three shapes this click produces.
      hint: landReason ?? (entry.sourceBranch ? describeLandStrategy(strategy, entry.sourceBranch) : undefined),
      // A land REFUSAL raises an error dialog owned by the menu component, so
      // the menu must survive the click; `doLand` closes it on the success path.
      keepsMenuOpen: true,
      run: actions.onLand,
    },
    {
      label: 'Reveal in Finder',
      icon: <FolderOpen size={12} color={colors.textSecondary} />,
      run: actions.onReveal,
    },
    {
      label: 'Re-provision',
      icon: <Package size={12} color={colors.textSecondary} />,
      run: actions.onReprovision,
    },
    {
      label: 'Retire worktree',
      icon: <Trash size={12} color={colors.textSecondary} />,
      // Owns the confirmation dialog and the busy guard, so it stays mounted;
      // the body is withdrawn by `dialogUp` in the component.
      keepsMenuOpen: true,
      run: actions.onRequestRetire,
    },
  ]
}
