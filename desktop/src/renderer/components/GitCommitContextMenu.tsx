import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useColors } from '../theme'
import { ConfirmDialog } from './git/ConfirmDialog'
import type { GitCommit } from '../../shared/types'

// ─── Commit context menu ───

export function CommitContextMenu({ anchor, commit, directory, onRefresh, onClose, onRebase }: {
  anchor: { x: number; y: number }
  commit: GitCommit
  directory: string
  onRefresh: () => void
  onClose: () => void
  onRebase?: (commit: GitCommit) => void
}) {
  const colors = useColors()
  const ref = useRef<HTMLDivElement>(null)
  const [confirmReset, setConfirmReset] = useState<'soft' | 'mixed' | 'hard' | null>(null)

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

  const items = [
    { label: 'Copy Commit Hash', action: () => navigator.clipboard.writeText(commit.fullHash) },
    { label: 'Copy Commit Message', action: () => navigator.clipboard.writeText(commit.subject) },
    { type: 'separator' as const },
    { label: 'Cherry-pick', action: async () => {
      const result = await window.ion.gitCherryPick(directory, commit.hash)
      if (!result.ok) alert(result.error || 'Cherry-pick failed')
      onRefresh()
    }},
    { label: 'Revert', action: async () => {
      const result = await window.ion.gitRevert(directory, commit.hash)
      if (!result.ok) alert(result.error || 'Revert failed')
      onRefresh()
    }},
    ...(onRebase ? [
      { type: 'separator' as const },
      { label: 'Interactive Rebase onto here…', action: () => { onRebase(commit); onClose() } },
    ] : []),
    { type: 'separator' as const },
    { label: 'Reset → Soft', action: async () => {
      const result = await window.ion.gitReset(directory, commit.hash, 'soft')
      if (!result.ok) alert(result.error || 'Reset failed')
      onRefresh()
    }},
    { label: 'Reset → Mixed', action: async () => {
      const result = await window.ion.gitReset(directory, commit.hash, 'mixed')
      if (!result.ok) alert(result.error || 'Reset failed')
      onRefresh()
    }},
    { label: 'Reset → Hard', danger: true, action: () => {
      setConfirmReset('hard')
    }},
  ]

  return (
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
          minWidth: 160,
        }}
      >
        {items.map((item, i) => {
          if ('type' in item && item.type === 'separator') {
            return <div key={i} style={{ height: 1, background: colors.containerBorder, margin: '4px 0' }} />
          }
          const isDanger = 'danger' in item && item.danger
          return (
            <div key={item.label} onClick={() => { item.action(); if (!('danger' in item)) onClose() }}
              style={{ height: 28, display: 'flex', alignItems: 'center', padding: '0 12px',
                fontSize: 11, color: isDanger ? '#c47060' : colors.textPrimary, cursor: 'pointer', userSelect: 'none' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>
              {item.label}
            </div>
          )
        })}
      </motion.div>

      {confirmReset === 'hard' && (
        <ConfirmDialog
          title="Hard Reset"
          message={`This will discard all changes and reset to ${commit.hash}. This cannot be undone.`}
          confirmLabel="Reset Hard"
          danger
          onConfirm={async () => {
            const result = await window.ion.gitReset(directory, commit.hash, 'hard')
            if (!result.ok) alert(result.error || 'Reset failed')
            setConfirmReset(null)
            onRefresh()
            onClose()
          }}
          onCancel={() => { setConfirmReset(null); onClose() }}
        />
      )}
    </>
  )
}
