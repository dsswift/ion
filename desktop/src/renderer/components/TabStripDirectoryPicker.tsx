import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { FolderPlus, FolderOpen, Trash } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore } from '../preferences'

interface DirectoryPickerProps {
  anchor: { x: number; y: number; bottom: number }
  onSelectDir: (dir: string) => void
  onClose: () => void
}

/** Popover that lists recent base directories (sorted by usage) and a "Choose directory..." action. */
export function DirectoryPicker({
  anchor,
  onSelectDir,
  onClose,
}: DirectoryPickerProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const recentDirs = usePreferencesStore((s) => s.recentBaseDirectories)
  const usageCounts = usePreferencesStore((s) => s.directoryUsageCounts)
  const [flipDown, setFlipDown] = useState(false)

  // Sort by usage frequency (descending), then alphabetically as tiebreaker
  const sortedDirs = [...recentDirs].sort((a, b) => {
    const countDiff = (usageCounts[b] || 0) - (usageCounts[a] || 0)
    if (countDiff !== 0) return countDiff
    return a.localeCompare(b)
  })

  // Flip to open downward if the popover overflows the top of the viewport
  useLayoutEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    if (rect.top < 0) setFlipDown(true)
  }, [])

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

  const handleChooseDirectory = async () => {
    const dir = await window.ion.selectDirectory()
    if (dir) {
      onSelectDir(dir)
      onClose()
    }
  }

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={ref}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left: anchor.x,
        ...(flipDown
          ? { top: anchor.bottom + 6 }
          : { bottom: (window.innerHeight / (usePreferencesStore.getState().uiZoom || 1)) - anchor.y + 6 }),
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 4,
        zIndex: 10000,
        minWidth: 220,
      }}
    >
      {sortedDirs.map((dir) => {
        const homePath = useSessionStore.getState().staticInfo?.homePath || ''
        const displayPath = homePath && dir.startsWith(homePath) ? '~' + dir.slice(homePath.length) : dir
        return (
          <div
            key={dir}
            className="flex items-center w-full rounded px-2 py-1.5"
            style={{
              fontSize: 12,
              color: colors.textPrimary,
              background: 'transparent',
              cursor: 'pointer',
            }}
            title={dir}
            onClick={() => { onSelectDir(dir); onClose() }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <FolderOpen size={14} color={colors.textSecondary} style={{ flexShrink: 0, marginRight: 8 }} />
            <span style={{ whiteSpace: 'nowrap', flex: 1 }}>{displayPath}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                usePreferencesStore.getState().removeRecentBaseDirectory(dir)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                marginLeft: 8,
                opacity: 0.5,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
              title="Remove from recents"
            >
              <Trash size={12} color={colors.textTertiary} />
            </button>
          </div>
        )
      })}
      {/* Separator when there are recent dirs */}
      {sortedDirs.length > 0 && (
        <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, margin: '4px 0' }} />
      )}
      <div
        className="flex items-center w-full rounded px-2 py-1.5"
        style={{
          fontSize: 12,
          color: colors.textSecondary,
          background: 'transparent',
          cursor: 'pointer',
        }}
        onClick={handleChooseDirectory}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <FolderPlus size={14} color={colors.textTertiary} style={{ flexShrink: 0, marginRight: 8 }} />
        <span>Choose directory...</span>
      </div>
    </motion.div>,
    popoverLayer,
  )
}
