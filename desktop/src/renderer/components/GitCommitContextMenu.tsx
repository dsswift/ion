import React, { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { useColors } from '../theme'
import type { GitCommit } from '../../shared/types'

// ─── Commit context menu ───

export function CommitContextMenu({ anchor, commit, onClose }: {
  anchor: { x: number; y: number }
  commit: GitCommit
  onClose: () => void
}) {
  const colors = useColors()
  const ref = useRef<HTMLDivElement>(null)

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
  ]

  return (
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
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
        >
          {item.label}
        </div>
      ))}
    </motion.div>
  )
}
