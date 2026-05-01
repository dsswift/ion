import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Check } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'

// ─── Finish Work context menu (right-click on finish button) ───

export function FinishWorkContextMenu({ anchor, worktree, onClose }: {
  anchor: { x: number; y: number }
  worktree: { branchName: string; sourceBranch: string; worktreePath: string; repoPath: string }
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const strategy = usePreferencesStore((s) => s.worktreeCompletionStrategy)
  const activeTabId = useSessionStore((s) => s.activeTabId)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  if (!popoverLayer) return null

  const items = [
    {
      label: `Merge into ${worktree.sourceBranch}`,
      isDefault: strategy === 'merge',
      action: () => useSessionStore.getState().finishWorktreeTab(activeTabId, 'merge'),
    },
    {
      label: `Push & create PR`,
      isDefault: strategy === 'pr',
      action: () => useSessionStore.getState().finishWorktreeTab(activeTabId, 'pr'),
    },
  ]

  return createPortal(
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
          onClick={() => { item.action(); onClose() }}
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
    </motion.div>,
    popoverLayer,
  )
}
