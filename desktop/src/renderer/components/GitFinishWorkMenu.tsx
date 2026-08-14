import React, { useRef, useState } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Check } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { rError, rInfo } from '../rendererLogger'
import { ConfirmDialog } from './git/ConfirmDialog'
import { describeLandStrategy } from '../../shared/worktree-land-strategy'
import type { WorktreeCompletionStrategy } from '../../shared/types'

// ─── Land worktree context menu (right-click on land button) ───

export function FinishWorkContextMenu({ anchor, worktree, onClose }: {
  anchor: { x: number; y: number }
  worktree: { branchName: string; sourceBranch: string; worktreePath: string; repoPath: string }
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (ATV top-anchored strip).
  useViewportClamp(ref, true)
  const strategy = usePreferencesStore((s) => s.worktreeCompletionStrategy)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  // This action lands work, then seals the checkout for read-only review.
  // Retire remains a separate explicit action, so landing never deletes the
  // worktree or closes its conversations.
  const [pending, setPending] = useState<WorktreeCompletionStrategy | null>(null)

  // Shared dismissal: the finish-work confirm dialog is a sibling of `ref`, so a
  // local click-outside handler would unmount it on the mousedown of its own
  // confirm button and the land would never run.
  useOutsideDismiss([ref], onClose)

  if (!popoverLayer) return null

  // Labels come from describeLandStrategy so they cannot drift from behaviour
  // again. The old first entry read "Fast-forward into <branch>" while the code
  // ran a plain merge — it fast-forwarded when it could and silently wrote a
  // merge commit when it could not.
  const items: Array<{ label: string; isDefault: boolean; strategy: WorktreeCompletionStrategy }> = [
    { label: describeLandStrategy('merge-ff', worktree.sourceBranch), isDefault: strategy === 'merge-ff', strategy: 'merge-ff' },
    { label: describeLandStrategy('merge', worktree.sourceBranch), isDefault: strategy === 'merge', strategy: 'merge' },
    { label: describeLandStrategy('pr', worktree.sourceBranch), isDefault: strategy === 'pr', strategy: 'pr' },
  ]

  return createPortal(
    <>
    <motion.div
      ref={ref}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left: anchor.x,
        top: anchor.y,
        pointerEvents: 'auto',
        background: colors.popoverBg,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        padding: '4px 0',
        zIndex: 10000,
        minWidth: 180,
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          onClick={() => setPending(item.strategy)}
          style={{
            height: 28,
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            fontSize: 11,
            color: colors.textPrimary,
            fontWeight: item.isDefault ? 600 : 400,
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
        >
          {item.isDefault && <Check size={10} style={{ marginRight: 6, flexShrink: 0 }} />}
          {item.label}
        </div>
      ))}
    </motion.div>

    {pending !== null && (
      <ConfirmDialog
        title="Land this worktree?"
        message={
          `${describeLandStrategy(pending, worktree.sourceBranch)}. ` +
          `${worktree.worktreePath} remains as a read-only review record after landing. ` +
          `Retire it separately when review is complete.`
        }
        confirmLabel="Land worktree"
        cancelLabel="Cancel"
        onConfirm={() => {
          const chosen = pending
          setPending(null)
          rInfo('git-finish-menu', 'finish work confirmed', { strategy: chosen, branch: worktree.branchName })
          Promise.resolve(useSessionStore.getState().finishWorktreeTab(activeTabId, chosen))
            .catch((err) => rError('git-finish-menu', 'finish worktree failed', { error: String(err) }))
          onClose()
        }}
        onCancel={() => { setPending(null); onClose() }}
      />
    )}
    </>,
    popoverLayer,
  )
}
