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
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { findMembership } from '../../shared/worktree-list'
import { ConfirmDialog } from './git/ConfirmDialog'
import { buildWorktreeMenuItems } from './WorktreeRowMenu.items'
import { buildWorktreeRowActions } from './worktreeRowActions'
import { rError, rWarn } from '../rendererLogger'
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

  // The async verbs and the bench reorder live in worktreeRowActions.ts. They
  // are built per render so they close over the current entry, draftTitle and
  // strategy, exactly as the inline declarations they replaced did.
  const { doLand, requestRetire, doRetire, doAddToBench, doRename, moveInBench } = buildWorktreeRowActions({
    entry,
    repoPath,
    strategy,
    draftTitle,
    enrolled,
    onClose,
    onRefresh,
    setBusy,
    setLandError,
    setConfirmRetire,
    setRetireOutcome,
    setRenaming,
  })

  // Merge order IS array position, so the menu reads and writes an index rather
  // than a stored rank that could disagree with the array assembly walks.
  const benchMembers = enrolled
    ? (benchWorkspaces ?? []).find((w) => w.sourceBranch === enrolled.sourceBranch)?.members ?? []
    : []
  const benchIndex = benchMembers.findIndex((m) => m.worktreePath === entry.worktreePath)
  const benchSize = benchMembers.length

  // The menu's verbs. Built in WorktreeRowMenu.items.tsx — WHAT the verbs are
  // and when each is available lives there; the operations they invoke and the
  // dialogs they raise stay here.
  const items = buildWorktreeMenuItems({
    entry,
    colors,
    strategy,
    enrolled,
    benchIndex,
    benchSize,
    alreadyInBench,
    actions: {
      onNewConversation: () => {
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
      onBeginRename: () => {
        setDraftTitle(entry.title ?? '')
        setRenaming(true)
      },
      onAddToBench: () => {
        void doAddToBench().catch((err) => rError('worktree.menu', 'add to bench threw', { error: String(err) }))
      },
      onSetReview: (verdict) => {
        if (!enrolled) return
        void useSessionStore.getState()
          .benchSetReview(repoPath, enrolled.sourceBranch, entry.worktreePath, verdict)
          .catch((err) => rError('worktree.menu', 'set review failed', { error: String(err) }))
        onClose()
      },
      onMoveInBench: moveInBench,
      onSync: () => {
        if (!entry.sourceBranch) return
        void useSessionStore.getState()
          .syncWorktree(entry.worktreePath, entry.sourceBranch, repoPath)
          .catch((err) => rError('worktree.menu', 'sync failed', { error: String(err) }))
      },
      onLand: () => {
        void doLand().catch((err) => rError('worktree.menu', 'land threw', { error: String(err) }))
      },
      onReveal: () => {
        void window.ion.revealPath(entry.worktreePath)
          .catch((err: unknown) => rError('worktree.menu', 'reveal failed', { error: String(err) }))
      },
      onReprovision: () => {
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
      onRequestRetire: () => {
        void requestRetire().catch((err) => rError('worktree.menu', 'retire appraisal threw', { error: String(err) }))
      },
    },
  })

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
