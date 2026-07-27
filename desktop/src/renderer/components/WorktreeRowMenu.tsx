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
import { ArrowLineDown, ArrowsClockwise, Flask, FolderOpen, Trash } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { ConfirmDialog } from './git/ConfirmDialog'
import { rError, rInfo, rWarn } from '../rendererLogger'
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
      const result = await window.ion.gitWorktreeLand({
        repoPath,
        worktreePath: entry.worktreePath,
        worktreeBranch: entry.branchName,
        sourceBranch: entry.sourceBranch,
      })
      if (!result.ok) {
        rWarn('worktree.menu', 'land refused', { branch: entry.branchName, error: result.error ?? '' })
      } else {
        rInfo('worktree.menu', 'landed', { branch: entry.branchName, mode: result.mode ?? '' })
      }
      onRefresh()
    } finally {
      setBusy(false)
      onClose()
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
      const result = await window.ion.gitWorktreeRetire({
        repoPath,
        worktreePath: entry.worktreePath,
        branchName: entry.branchName,
        // Force only after the operator confirmed against a concrete appraisal.
        force: true,
      })
      if (!result.ok) {
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
      if (!result.ok) {
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

  const items: Array<{ label: string; icon: React.ReactNode; disabled?: boolean; hint?: string; run(): void }> = [
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
      hint: landReason,
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
        {items.map((item) => (
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
