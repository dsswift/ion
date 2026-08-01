/**
 * WorktreeRowMenu — the per-worktree verb menu.
 *
 * The destructive verbs live behind this menu rather than on the row, so a
 * mis-click cannot retire a worktree. Retire itself goes through the appraised
 * path (main/worktree/safety.ts) and refuses when work would be lost, so this
 * menu cannot destroy anything on its own.
 */
import React, { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLineDown, ArrowsClockwise, Bug, ChatCircle, Check, Flask, FolderOpen, Package, PencilSimple, Trash } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { landFlagsForStrategy, describeLandStrategy } from '../../shared/worktree-land-strategy'
import { findMembership } from '../../shared/worktree-list'
import { ConfirmDialog } from './git/ConfirmDialog'
import { rDebug, rError, rInfo, rWarn } from '../rendererLogger'
import type { WorktreeInventoryEntry } from '../../shared/types'

export function WorktreeRowMenu({
  entry,
  anchor,
  repoPath,
  onClose,
  onRefresh,
}: {
  entry: WorktreeInventoryEntry
  anchor: { x: number; y: number }
  repoPath: string
  onClose(): void
  onRefresh(): void
}): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const benchWorkspaces = useSessionStore((s) => s.benchWorkspaces.get(repoPath))
  const [confirmRetire, setConfirmRetire] = useState<string | null>(null)
  // Inline rename state. The generated title is a good default, not an
  // authority — the operator must be able to correct one that missed.
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState(entry.title ?? entry.label)
  // A land refusal (diverged branch, conflict) is actionable and must be shown,
  // not swallowed into the log while the menu closes as if it had worked.
  const [landError, setLandError] = useState<string | null>(null)
  // The retire outcome the operator must read: either the recovery ref that now
  // holds their uncommitted work, or the reason the worktree was kept.
  const [retireOutcome, setRetireOutcome] = useState<string | null>(null)
  const strategy = usePreferencesStore((s) => s.worktreeCompletionStrategy)
  const [busy, setBusy] = useState(false)

  // Dismissal goes through the shared hook so the retire/land confirm dialogs
  // this menu raises are exempt from click-outside. A local handler here is what
  // made the Retire confirm button inert: the dialog is a sibling of `ref`, so
  // its mousedown read as "outside" and unmounted the menu mid-click.
  //
  // The `busy` guard closes the remaining hole. `ConfirmDialog` suppressing its
  // own Escape is not enough — this hook's Escape listener is a separate
  // `window` handler, and `onClose` unmounts the menu AND the dialog with it,
  // mid-operation, leaving the outcome (including a recovery ref that exists
  // nowhere else) with nothing to render into.
  const dismiss = useCallback(() => {
    if (busy) return
    onClose()
  }, [busy, onClose])
  useOutsideDismiss([ref], dismiss)

  if (!popoverLayer) return null

  // Already a member of any bench for this repo? Enrolling twice is refused by
  // the store, but the menu should say so rather than offering a dead action.
  const alreadyInBench = (benchWorkspaces ?? []).some((ws) =>
    ws.members.some((m) => m.worktreePath === entry.worktreePath))

  // The membership record and which bench holds it. Resolved through the shared
  // finder so the menu, the row, and the wire projection agree about which
  // bench a worktree belongs to.
  const enrolled = findMembership(benchWorkspaces ?? [], entry.worktreePath)

  // Without a known source branch the land/sync verbs are unanswerable: git
  // does not record what a worktree was cut from, and guessing would land work
  // in the wrong branch. Disable rather than guess.
  const canLand = !!entry.sourceBranch && entry.unlandedCommitCount > 0 && !entry.isDirty
  const landReason = !entry.sourceBranch
    ? 'Source branch unknown'
    : entry.isDirty
      ? 'Commit changes first'
      : entry.unlandedCommitCount === 0
        ? 'Nothing to land'
        : ''

  async function doLand(): Promise<void> {
    if (!entry.sourceBranch) return
    setBusy(true)
    try {
      // Honour the operator's configured strategy. This used to pass no flags
      // at all, so a "Merge (ff)" setting silently produced a merge commit
      // whenever the source branch had moved on.
      const flags = landFlagsForStrategy(strategy)
      const result = await window.ion.gitWorktreeLand({
        repoPath,
        worktreePath: entry.worktreePath,
        worktreeBranch: entry.branchName,
        sourceBranch: entry.sourceBranch,
        noFf: flags.noFf,
        syncFirst: flags.syncFirst,
        requireFastForward: flags.requireFastForward,
      })
      if (!result.ok) {
        rWarn('worktree.menu', 'land refused', {
          branch: entry.branchName,
          has_conflicts: !!result.hasConflicts,
          error: result.error ?? '',
        })
        // A CONFLICT is not the same as a refusal. A refusal (diverged branch,
        // dirty tree) is answered by this dialog and nothing is left behind; a
        // conflict stops the merge halfway and leaves a checkout that needs
        // resolving, which must reach the toast and the row badge exactly as a
        // conflicted sync does. Without this the land path repeated the defect
        // the sync path was fixed for: an actionable failure visible only in
        // the log.
        //
        // Keyed on the directory the LAND reported, not on this worktree: the
        // merge runs in whichever checkout holds the source branch (usually the
        // base repo), and only a pre-sync conflict lands in the worktree.
        // Pointing the resolution dialog at the wrong directory would open it
        // on a clean tree.
        if (result.hasConflicts && result.conflictDirectory) {
          useSessionStore.getState().recordConflictAlert(result.conflictDirectory, {
            source: 'land',
            kind: 'conflict',
            message: result.error,
            label: result.conflictDirectory === entry.worktreePath
              ? (entry.title || entry.label)
              : result.conflictDirectory.split('/').filter(Boolean).pop(),
          })
        }
        // A refusal is actionable (sync first, resolve a conflict) and must not
        // vanish: surface it rather than leaving the operator to wonder why the
        // branch did not move.
        setLandError(result.error ?? 'Land failed.')
        return
      }
      rInfo('worktree.menu', 'landed', { branch: entry.branchName, mode: result.mode ?? '' })
      onRefresh()
      // Success dismisses the menu. The refusal path above returns early and
      // leaves it mounted on purpose, because the error dialog it raised is a
      // child of this component and would go with it.
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Retire asks the appraisal first and surfaces exactly what would be lost.
   * The appraisal fails CLOSED, so an unreadable worktree is never presented as
   * safe to remove.
   *
   * The appraisal decides what the confirmation SAYS. It never decides whether
   * to confirm. This used to run the retire immediately when `safeToDiscard` was
   * true, so a landed worktree was deleted on a single menu click with no prompt
   * and no menu dismissal — the operator saw a context menu still sitting open,
   * then the row vanished two seconds later. Removing a checkout is destructive
   * whether or not the work is recoverable, and "nothing would be lost" is the
   * appraisal's opinion about git state, not the operator's confirmation that
   * they meant to click it.
   */
  async function requestRetire(): Promise<void> {
    if (!entry.sourceBranch) {
      setConfirmRetire('Ion cannot tell what this worktree still holds, because its source branch is unknown.')
      return
    }
    const appraisal = await window.ion.gitWorktreeAppraise(entry.worktreePath, entry.sourceBranch)
    rInfo('worktree.menu', 'retire appraised', {
      branch: entry.branchName,
      safe_to_discard: appraisal.safeToDiscard,
      uncommitted: appraisal.uncommittedPaths.length,
      unlanded: appraisal.unlandedCommitCount,
    })
    // Both arms confirm. Only the wording differs: a fully-landed worktree is
    // reported as costing nothing, which is information the operator wants
    // BEFORE deciding, not a reason to skip asking.
    setConfirmRetire(appraisal.safeToDiscard
      ? 'Everything in this worktree has landed, so nothing would be lost.'
      : appraisal.reason ?? 'This worktree may still hold work.')
  }

  async function doRetire(): Promise<void> {
    setBusy(true)
    try {
      // Routed through the store action rather than calling the IPC directly:
      // retire deletes the directory, so any conversation living in it must be
      // relocated first, and that read-then-mutate sequence must run in the
      // owner window. See retireWorktree in worktree-inventory-slice.ts.
      const result = await useSessionStore.getState().retireWorktree(
        repoPath,
        entry.worktreePath,
        entry.branchName,
      )
      // In the ATV window this is a FORWARDED action: the owner executes it and
      // its return value rides back over the round trip, so `result` is the
      // owner's real answer (see applyMirrorOverrides). It is absent only when
      // the round trip itself failed — no owner window, or no reply before
      // main's deadline — which is "no answer available", not "it failed", so
      // that case is logged rather than read as a refusal.
      if (!result) {
        rDebug('worktree.menu', 'retire returned no result (owner round trip did not complete)', {
          branch: entry.branchName,
        })
      } else if (!result.ok) {
        rWarn('worktree.menu', 'retire failed', { branch: entry.branchName, error: result.error ?? '' })
        // A refusal is actionable — most often "the recovery snapshot could not
        // be written, so the worktree was kept". Leaving it in the log while the
        // menu closes is what made the original defect look like a dead button.
        setRetireOutcome(result.error ?? 'Retire failed.')
        onRefresh()
        return
      }
      // Name the recovery ref. The confirmation promised the work was preserved;
      // a ref the operator never sees is indistinguishable from one that was
      // never written.
      if (result.recoveryRef) {
        rInfo('worktree.menu', 'retired with recovery ref', {
          branch: entry.branchName, recovery_ref: result.recoveryRef,
        })
        setRetireOutcome(
          `Retired. Uncommitted work was preserved to ${result.recoveryRef} in the repo. ` +
          `Recover it with: git checkout -b recovered ${result.recoveryRef}`,
        )
        onRefresh()
        return
      }
      rInfo('worktree.menu', 'retired', { branch: entry.branchName })
      onRefresh()
      setConfirmRetire(null)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Enroll this worktree in its bench, creating the bench if it does not exist.
   *
   * The bench is created silently on FIRST ENROLLMENT rather than as its own
   * user-facing step: `ensureWorkspace` writes a record, not a worktree (the
   * directory is materialised lazily by the first assembly), so "create a bench"
   * commits the operator to nothing and would be a meaningless extra click.
   * Which bench a worktree belongs to is fully determined by its repo and
   * source branch, so there is nothing to choose either.
   */
  async function doAddToBench(): Promise<void> {
    if (!entry.sourceBranch) return
    // No setBusy / onClose here: this item is not `keepsMenuOpen`, so the click
    // handler has already withdrawn the menu and this component is unmounting.
    // Setting state afterwards would be a no-op, and calling onClose again would
    // be a second dismissal of an already-dismissed menu.
    const result = await useSessionStore.getState()
      .benchAddMember(repoPath, entry.sourceBranch, entry.worktreePath, entry.branchName)
    // Same round-trip caveat as doRetire: absent only when the forwarded call
    // never concluded, never merely because the mirror ran it.
    if (!result) {
      rDebug('worktree.menu', 'add to bench returned no result (owner round trip did not complete)', {
        branch: entry.branchName,
      })
    } else if (!result.ok) {
      rWarn('worktree.menu', 'add to bench refused', { branch: entry.branchName, error: result.error ?? '' })
    } else {
      rInfo('worktree.menu', 'added to bench', { branch: entry.branchName, source_branch: entry.sourceBranch })
    }
    onRefresh()
  }

  /**
   * Apply an operator-supplied title. Empty input is a cancel, not a clear:
   * blanking the name would drop the row back to its hex slug, which is never
   * what someone typing into a rename field is asking for.
   */
  async function doRename(): Promise<void> {
    const next = draftTitle.trim()
    if (!next || next === (entry.title ?? '')) {
      setRenaming(false)
      onClose()
      return
    }
    setBusy(true)
    try {
      const result = await window.ion.gitWorktreeSetTitle({
        worktreePath: entry.worktreePath,
        repoPath,
        title: next,
      })
      if (!result.ok) {
        rWarn('worktree.menu', 'rename refused', {
          worktree_path: entry.worktreePath, error: result.error ?? '',
        })
      } else {
        rInfo('worktree.menu', 'worktree renamed', { worktree_path: entry.worktreePath, title: next })
      }
      onRefresh()
    } finally {
      setBusy(false)
      setRenaming(false)
      onClose()
    }
  }

  // Merge order IS array position, so the menu reads and writes an index rather
  // than a stored rank that could disagree with the array assembly walks.
  const benchMembers = enrolled
    ? (benchWorkspaces ?? []).find((w) => w.sourceBranch === enrolled.sourceBranch)?.members ?? []
    : []
  const benchIndex = benchMembers.findIndex((m) => m.worktreePath === entry.worktreePath)
  const benchSize = benchMembers.length

  function moveInBench(toIndex: number): void {
    if (!enrolled) return
    void useSessionStore.getState()
      .benchSetOrder(repoPath, enrolled.sourceBranch, entry.worktreePath, toIndex)
      .catch((err) => rError('worktree.menu', 'reorder failed', { error: String(err) }))
    onClose()
  }

  /**
   * The menu's verbs.
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
   *
   * `keepsMenuOpen` is the single opt-out, for items that REPLACE the menu body
   * with their own UI rather than dismissing it. Rename swaps in an inline
   * editor; retire withdraws the body behind its confirmation but must stay
   * mounted because it owns the dialog state and the busy guard.
   */
  const items: Array<{
    label: string
    icon: React.ReactNode
    disabled?: boolean
    hint?: string
    /** Item renders its own UI in place of the menu; it handles its own exit. */
    keepsMenuOpen?: boolean
    run(): void
  }> = [
    {
      // The row CLICK opens or cycles existing conversations; this creates an
      // additional one. Two distinct verbs, so the second gets a menu entry
      // rather than a second gutter button that looks like the first.
      label: 'New conversation here',
      icon: <ChatCircle size={12} color={colors.accent} />,
      run: () => {
        // The store action, NOT createTabInDirectory. Creating the tab is only
        // half the job: it must also be given its worktree metadata, or the git
        // panel cannot resolve which repo's worktrees to list and falls back to
        // the worktree's own `git worktree list`. Calling the raw create here was
        // exactly that bug -- a second conversation in a worktree showed a
        // different, wrong worktree panel from the first.
        void useSessionStore.getState()
          .newWorktreeConversation(entry.worktreePath)
          .catch((err) => rError('worktree.menu', 'new conversation failed', { error: String(err) }))
        onClose()
      },
    },
    {
      label: entry.title ? 'Rename worktree' : 'Name this worktree',
      icon: <PencilSimple size={12} color={colors.textSecondary} />,
      // Named lazily from the first prompt, so a worktree that has not been
      // prompted in yet still needs a manual way to get a name.
      hint: entry.title ? '' : 'Not named yet',
      // Swaps the menu body for the inline editor.
      keepsMenuOpen: true,
      run: () => {
        setDraftTitle(entry.title ?? '')
        setRenaming(true)
      },
    },
    {
      label: alreadyInBench ? 'Already in the bench' : 'Add to integration bench',
      icon: <Flask size={12} color={alreadyInBench || !entry.sourceBranch ? colors.textTertiary : colors.accent} />,
      disabled: alreadyInBench || !entry.sourceBranch,
      hint: !entry.sourceBranch ? 'Source branch unknown' : '',
      run: () => { void doAddToBench().catch((err) => rError('worktree.menu', 'add to bench threw', { error: String(err) })) },
    },
    // Review verdicts. These live in the row's state slot only when nothing more
    // urgent needs it, so the menu is where they are always reachable -- and
    // where a verdict can be cleared by selecting the one already set.
    ...(enrolled ? [
      {
        label: enrolled.membership.review === 'good' ? 'Clear reviewed good' : 'Mark reviewed good',
        icon: <Check size={12} color={enrolled.membership.review === 'good' ? colors.worktreeGreen : colors.textSecondary} />,
        run: () => {
          void useSessionStore.getState()
            .benchSetReview(repoPath, enrolled.sourceBranch, entry.worktreePath,
              enrolled.membership.review === 'good' ? null : 'good')
            .catch((err) => rError('worktree.menu', 'set review failed', { error: String(err) }))
          onClose()
        },
      },
      {
        label: enrolled.membership.review === 'issue' ? 'Clear review issue' : 'Mark review issue',
        icon: <Bug size={12} color={enrolled.membership.review === 'issue' ? colors.dangerFg : colors.textSecondary} />,
        run: () => {
          void useSessionStore.getState()
            .benchSetReview(repoPath, enrolled.sourceBranch, entry.worktreePath,
              enrolled.membership.review === 'issue' ? null : 'issue')
            .catch((err) => rError('worktree.menu', 'set review failed', { error: String(err) }))
          onClose()
        },
      },
      // Keyboard-reachable reorder. Dragging the rail is the direct gesture, but
      // a drag is not available to every operator or every input device.
      {
        label: 'Move earlier in the merge',
        icon: <ArrowLineDown size={12} color={colors.textSecondary} style={{ transform: 'rotate(180deg)' }} />,
        disabled: benchIndex <= 0,
        hint: benchIndex <= 0 ? 'Already first' : '',
        run: () => { moveInBench(benchIndex - 1) },
      },
      {
        label: 'Move later in the merge',
        icon: <ArrowLineDown size={12} color={colors.textSecondary} />,
        disabled: benchIndex < 0 || benchIndex >= benchSize - 1,
        hint: benchIndex >= benchSize - 1 ? 'Already last' : '',
        run: () => { moveInBench(benchIndex + 1) },
      },
    ] : []),
    {
      label: `Sync from ${entry.sourceBranch ?? 'source'}`,
      icon: <ArrowsClockwise size={12} color={colors.textSecondary} />,
      disabled: !entry.sourceBranch || entry.isDirty,
      hint: !entry.sourceBranch ? 'Source branch unknown' : entry.isDirty ? 'Commit changes first' : '',
      run: () => {
        if (!entry.sourceBranch) return
        void useSessionStore.getState()
          .syncWorktree(entry.worktreePath, entry.sourceBranch, repoPath)
          .catch((err) => rError('worktree.menu', 'sync failed', { error: String(err) }))
      },
    },
    {
      label: `Land into ${entry.sourceBranch ?? 'source'}`,
      icon: <ArrowLineDown size={12} color={canLand ? colors.worktreeGreen : colors.textTertiary} />,
      disabled: !canLand,
      // Name the strategy that will actually run, so the operator is not
      // guessing which of the three shapes this click produces.
      hint: landReason ?? (entry.sourceBranch ? describeLandStrategy(strategy, entry.sourceBranch) : undefined),
      // A land REFUSAL raises an error dialog owned by this component, so the
      // menu must survive the click; `doLand` closes it on the success path.
      keepsMenuOpen: true,
      run: () => { void doLand().catch((err) => rError('worktree.menu', 'land threw', { error: String(err) })) },
    },
    {
      label: 'Reveal in Finder',
      icon: <FolderOpen size={12} color={colors.textSecondary} />,
      run: () => {
        void window.ion.revealPath(entry.worktreePath)
          .catch((err: unknown) => rError('worktree.menu', 'reveal failed', { error: String(err) }))
      },
    },
    {
      label: 'Re-provision',
      icon: <Package size={12} color={colors.textSecondary} />,
      run: () => {
        void useSessionStore.getState()
          .reprovisionWorktree(repoPath, entry.worktreePath)
          .then((result) => {
            if (!result.ok) {
              rWarn('worktree.menu', 'reprovision failed', {
                branch: entry.branchName, error: result.error ?? '',
              })
            }
            onRefresh()
          })
          .catch((err) => rError('worktree.menu', 'reprovision threw', { error: String(err) }))
      },
    },
    {
      label: 'Retire worktree',
      icon: <Trash size={12} color={colors.textSecondary} />,
      // Owns the confirmation dialog and the busy guard, so it stays mounted;
      // the body is withdrawn by `dialogUp` below.
      keepsMenuOpen: true,
      run: () => { void requestRetire().catch((err) => rError('worktree.menu', 'retire appraisal threw', { error: String(err) })) },
    },
  ]

  // A dialog raised BY this menu replaces it. The menu is the thing that asked
  // the question; leaving it open behind its own confirmation reads as "the
  // click did nothing", which is exactly what the operator reported — a context
  // menu still sitting there while a retire ran behind it. The menu stays
  // MOUNTED (it owns the dialog state and the busy guard); only its body is
  // withdrawn.
  const dialogUp = confirmRetire !== null || retireOutcome !== null || landError !== null

  return createPortal(
    <>
      {!dialogUp && (
      <motion.div
        ref={ref}
        data-ion-ui
        data-testid="worktree-row-menu"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.1 }}
        style={{
          position: 'fixed', left: anchor.x, top: anchor.y,
          pointerEvents: 'auto',
          background: colors.popoverBg,
          border: `1px solid ${colors.popoverBorder}`,
          borderRadius: 6, padding: '3px 0', zIndex: 10000, minWidth: 190,
          boxShadow: colors.popoverShadow,
        }}
      >
        {renaming ? (
          /* Inline, in the menu that opened it: a separate modal for a single
             text field would be a second dialog to dismiss for a one-word edit. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 10px', minWidth: 220 }}>
            <span style={{ fontSize: 9, color: colors.textTertiary }}>
              Describe what this worktree is for
            </span>
            <input
              data-testid="worktree-rename-input"
              autoFocus
              value={draftTitle}
              placeholder={entry.label}
              disabled={busy}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  void doRename().catch((err) => rError('worktree.menu', 'rename threw', { error: String(err) }))
                } else if (e.key === 'Escape') {
                  setRenaming(false)
                  onClose()
                }
              }}
              style={{
                fontSize: 11, padding: '3px 6px', borderRadius: 4,
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                color: colors.textPrimary, outline: 'none',
              }}
            />
            <span style={{ fontSize: 9, color: colors.textTertiary }}>
              Enter to save · Esc to cancel
            </span>
          </div>
        ) : items.map((item) => (
          <button
            key={item.label}
            disabled={item.disabled || busy}
            /* ONE dismissal point for every item. Fire the verb, then withdraw
               the menu in the same tick unless the item replaces the menu with
               its own UI. Ordering matters: `run()` first, because a handler
               that opens a dialog must set that state before this callback
               returns, and `onClose` is the parent's unmount. */
            onClick={() => {
              item.run()
              if (!item.keepsMenuOpen) onClose()
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              padding: '4px 10px', background: 'transparent', border: 'none',
              fontSize: 11, textAlign: 'left',
              color: item.disabled ? colors.textTertiary : colors.textPrimary,
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              opacity: item.disabled ? 0.55 : 1,
            }}
            onMouseEnter={(e) => { if (!item.disabled) (e.currentTarget as HTMLElement).style.background = colors.surfaceHover }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            {item.icon}
            <span>{item.label}</span>
            {/* Disabled reasons are stated inline, never left mysterious. */}
            {item.disabled && item.hint && (
              <span style={{ marginLeft: 'auto', fontSize: 9, color: colors.textTertiary }}>{item.hint}</span>
            )}
          </button>
        ))}
      </motion.div>
      )}

      {landError !== null && (
        <ConfirmDialog
          title="Land did not complete"
          message={landError}
          acknowledge
          onConfirm={() => { setLandError(null); onClose() }}
          onCancel={() => { setLandError(null); onClose() }}
        />
      )}

      {retireOutcome !== null && (
        <ConfirmDialog
          title="Retire"
          message={retireOutcome}
          acknowledge
          onConfirm={() => { setRetireOutcome(null); setConfirmRetire(null); onClose() }}
          onCancel={() => { setRetireOutcome(null); setConfirmRetire(null); onClose() }}
        />
      )}

      {retireOutcome === null && confirmRetire !== null && (
        <ConfirmDialog
          title="Retire this worktree?"
          message={`${confirmRetire} Retiring removes the directory and its branch. Work is preserved to a recovery ref first, but this is not a routine action.`}
          confirmLabel="Retire"
          cancelLabel="Keep it"
          danger
          /* The retire takes seconds (appraise, snapshot the work to a recovery
             ref, delete the directory, relocate conversations). This dialog stays
             mounted across that await, so the same dialog reports the operation
             in place and the success path then swaps it for the outcome. */
          busy={busy}
          busyLabel="Retiring the worktree…"
          onConfirm={() => { void doRetire().catch((err) => rError('worktree.menu', 'retire threw', { error: String(err) })) }}
          onCancel={() => { setConfirmRetire(null); onClose() }}
        />
      )}
    </>,
    popoverLayer,
  )
}
