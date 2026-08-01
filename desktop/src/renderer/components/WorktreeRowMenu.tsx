/**
 * WorktreeRowMenu — the per-worktree verb menu.
 *
 * The destructive verbs live behind this menu rather than on the row, so a
 * mis-click cannot retire a worktree. Retire itself goes through the appraised
 * path (main/worktree/safety.ts) and refuses when work would be lost, so this
 * menu cannot destroy anything on its own.
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLineDown, ArrowsClockwise, Flask, FolderOpen, Package, PencilSimple, Trash } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { landFlagsForStrategy, describeLandStrategy } from '../../shared/worktree-land-strategy'
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
  const strategy = usePreferencesStore((s) => s.worktreeCompletionStrategy)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (!popoverLayer) return null

  // Already a member of any bench for this repo? Enrolling twice is refused by
  // the store, but the menu should say so rather than offering a dead action.
  const alreadyInBench = (benchWorkspaces ?? []).some((ws) =>
    ws.members.some((m) => m.worktreePath === entry.worktreePath))

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
    } finally {
      setBusy(false)
    }
  }

  /**
   * Retire asks the appraisal first and surfaces exactly what would be lost.
   * The appraisal fails CLOSED, so an unreadable worktree is never presented as
   * safe to remove.
   */
  async function requestRetire(): Promise<void> {
    if (!entry.sourceBranch) {
      setConfirmRetire('Ion cannot tell what this worktree still holds, because its source branch is unknown.')
      return
    }
    const appraisal = await window.ion.gitWorktreeAppraise(entry.worktreePath, entry.sourceBranch)
    setConfirmRetire(appraisal.safeToDiscard
      ? null
      : appraisal.reason ?? 'This worktree may still hold work.')
    if (appraisal.safeToDiscard) await doRetire()
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
      }
      onRefresh()
    } finally {
      setBusy(false)
      setConfirmRetire(null)
      onClose()
    }
  }

  /**
   * Enroll this worktree in its bench, creating the bench if it does not exist.
   *
   * The bench is created silently on FIRST ENROLLMENT rather than as its own
   * user-facing step: `ensureWorkspace` writes a record, not a worktree (the
   * directory is materialised lazily by the first rebuild), so "create a bench"
   * commits the operator to nothing and would be a meaningless extra click.
   * Which bench a worktree belongs to is fully determined by its repo and
   * source branch, so there is nothing to choose either.
   */
  async function doAddToBench(): Promise<void> {
    if (!entry.sourceBranch) return
    setBusy(true)
    try {
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
    } finally {
      setBusy(false)
      onClose()
    }
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

  const items: Array<{ label: string; icon: React.ReactNode; disabled?: boolean; hint?: string; run(): void }> = [
    {
      label: entry.title ? 'Rename worktree' : 'Name this worktree',
      icon: <PencilSimple size={12} color={colors.textSecondary} />,
      // Named lazily from the first prompt, so a worktree that has not been
      // prompted in yet still needs a manual way to get a name.
      hint: entry.title ? '' : 'Not named yet',
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
        onClose()
      },
    },
    {
      label: `Land into ${entry.sourceBranch ?? 'source'}`,
      icon: <ArrowLineDown size={12} color={canLand ? colors.worktreeGreen : colors.textTertiary} />,
      disabled: !canLand,
      // Name the strategy that will actually run, so the operator is not
      // guessing which of the three shapes this click produces.
      hint: landReason ?? (entry.sourceBranch ? describeLandStrategy(strategy, entry.sourceBranch) : undefined),
      run: () => { void doLand().catch((err) => rError('worktree.menu', 'land threw', { error: String(err) })) },
    },
    {
      label: 'Reveal in Finder',
      icon: <FolderOpen size={12} color={colors.textSecondary} />,
      run: () => {
        void window.ion.revealPath(entry.worktreePath)
          .catch((err: unknown) => rError('worktree.menu', 'reveal failed', { error: String(err) }))
        onClose()
      },
    },
    {
      label: 'Re-provision',
      icon: <Package size={12} color={colors.textSecondary} />,
      run: () => {
        setBusy(true)
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
          .finally(() => { setBusy(false); onClose() })
      },
    },
    {
      label: 'Retire worktree',
      icon: <Trash size={12} color={colors.textSecondary} />,
      run: () => { void requestRetire().catch((err) => rError('worktree.menu', 'retire appraisal threw', { error: String(err) })) },
    },
  ]

  return createPortal(
    <>
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
            onClick={item.run}
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

      {landError !== null && (
        <ConfirmDialog
          title="Land did not complete"
          message={landError}
          confirmLabel="OK"
          cancelLabel="Dismiss"
          onConfirm={() => { setLandError(null); onClose() }}
          onCancel={() => { setLandError(null); onClose() }}
        />
      )}

      {confirmRetire !== null && (
        <ConfirmDialog
          title="Retire this worktree?"
          message={`${confirmRetire} Retiring removes the directory and its branch. Work is preserved to a recovery ref first, but this is not a routine action.`}
          confirmLabel="Retire"
          cancelLabel="Keep it"
          danger
          onConfirm={() => { void doRetire().catch((err) => rError('worktree.menu', 'retire threw', { error: String(err) })) }}
          onCancel={() => { setConfirmRetire(null); onClose() }}
        />
      )}
    </>,
    popoverLayer,
  )
}
