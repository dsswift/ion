import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Gear } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { usePopoverLayer } from './PopoverLayer'

interface EngineProfilePickerProps {
  anchor: { x: number; y: number }
  onSelect: (profileId: string) => void
  onOpenSettings: () => void
  onClose: () => void
}

export function EngineProfilePicker({ anchor, onSelect, onOpenSettings, onClose }: EngineProfilePickerProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const profiles = usePreferencesStore((s) => s.engineProfiles)

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
        bottom: (window.innerHeight / (usePreferencesStore.getState().uiZoom || 1)) - anchor.y + 6,
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 4,
        zIndex: 10001,
        minWidth: 200,
      }}
    >
      {profiles.map((profile) => (
        <div
          key={profile.id}
          className="flex flex-col w-full rounded px-2 py-1.5"
          style={{
            fontSize: 12,
            color: colors.textPrimary,
            background: 'transparent',
            cursor: 'pointer',
          }}
          onClick={() => { onSelect(profile.id); onClose() }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <span style={{ fontWeight: 600 }}>{profile.name}</span>
          <span style={{
            fontSize: 10,
            color: colors.textTertiary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {[profile.extensionDir.split('/').pop() || profile.extensionDir, profile.options?.defaultTeam].filter(Boolean).join(' | ')}
          </span>
        </div>
      ))}
      {profiles.length > 0 && (
        <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, margin: '4px 0' }} />
      )}
      <div
        className="flex items-center gap-2 w-full rounded px-2 py-1.5"
        style={{
          fontSize: 12,
          color: colors.textSecondary,
          background: 'transparent',
          cursor: 'pointer',
        }}
        onClick={() => { onOpenSettings(); onClose() }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <Gear size={14} color={colors.textTertiary} />
        <span>Configure in Settings...</span>
      </div>
    </motion.div>,
    popoverLayer,
  )
}
