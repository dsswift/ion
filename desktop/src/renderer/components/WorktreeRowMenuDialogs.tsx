/**
 * WorktreeRowMenuDialogs — the three confirmation/outcome dialogs the worktree
 * verb menu raises.
 *
 * Extracted from WorktreeRowMenu.tsx, which crossed the 600-line cap. This is
 * the natural seam: the dialogs are pure presentation over four pieces of state
 * the menu already owns, they take no store or IPC dependency of their own, and
 * nothing else in the menu body reads them.
 *
 * The dialog STATE stays with the menu on purpose. It owns the `busy` guard that
 * keeps the retire confirm mounted across the operation, and the outcome text
 * (which can carry a recovery ref that exists nowhere else) must survive until
 * the operator acknowledges it. Moving that state here would split one
 * invariant across two files.
 */
import React from 'react'
import { ConfirmDialog } from './git/ConfirmDialog'
import { rError } from '../rendererLogger'

export function WorktreeRowMenuDialogs({
  landError,
  setLandError,
  retireOutcome,
  setRetireOutcome,
  confirmRetire,
  setConfirmRetire,
  busy,
  doRetire,
  onClose,
}: {
  landError: string | null
  setLandError: (v: string | null) => void
  retireOutcome: string | null
  setRetireOutcome: (v: string | null) => void
  confirmRetire: string | null
  setConfirmRetire: (v: string | null) => void
  busy: boolean
  doRetire: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  return (
    <>
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
    </>
  )
}

/**
 * The inline rename editor that replaces the menu body.
 *
 * Inline, in the menu that opened it: a separate modal for a single text field
 * would be a second dialog to dismiss for a one-word edit. Extracted alongside
 * the dialogs for the same reason — presentation over state the menu owns.
 */
export function WorktreeRenameEditor({
  draftTitle,
  setDraftTitle,
  placeholder,
  busy,
  doRename,
  setRenaming,
  onClose,
  colors,
}: {
  draftTitle: string
  setDraftTitle: (v: string) => void
  placeholder: string
  busy: boolean
  doRename: () => Promise<void>
  setRenaming: (v: boolean) => void
  onClose: () => void
  colors: Record<string, string>
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 10px', minWidth: 220 }}>
      <span style={{ fontSize: 9, color: colors.textTertiary }}>
        Describe what this worktree is for
      </span>
      <input
        data-testid="worktree-rename-input"
        autoFocus
        value={draftTitle}
        placeholder={placeholder}
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
  )
}
