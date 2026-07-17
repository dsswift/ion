import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Gear } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { usePopoverLayer } from './PopoverLayer'

// Re-export so existing callers in TabStrip.tsx can import from one place.
export { resolveNewConversationAction, executeNewConversationAction, newTabInDirectory } from './new-conversation-routing'
export type { NewConversationAction } from './new-conversation-routing'

// ─── NewConversationPicker ────────────────────────────────────────────────────
//
// Extended profile picker with a "Plain conversation / No extensions" item at
// the top, a divider, then all engine profiles, then the Settings footer.
// ─────────────────────────────────────────────────────────────────────────────

interface NewConversationPickerProps {
  anchor: { x: number; y: number; bottom: number }
  /** Called when the user chooses "plain conversation" (no profile). */
  onPlain: () => void
  /** Called when the user picks a specific engine profile. */
  onProfile: (profileId: string) => void
  /** Called when the user clicks "Configure in Settings...". */
  onOpenSettings: () => void
  onClose: () => void
}

export function NewConversationPicker({
  anchor,
  onPlain,
  onProfile,
  onOpenSettings,
  onClose,
}: NewConversationPickerProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (ATV top-anchored strip).
  useViewportClamp(ref, true)
  const profiles = usePreferencesStore((s) => s.engineProfiles)
  const defaultId = usePreferencesStore((s) => s.defaultEngineProfileId)
  const [flipDown, setFlipDown] = useState(false)

  // Flip to open downward if the popover overflows the top of the viewport.
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
        zIndex: 10001,
        minWidth: 200,
      }}
    >
      {/* Plain conversation — always at the top */}
      <PickerRow
        label="Plain conversation"
        sublabel="No extensions"
        accentDot={false}
        colors={colors}
        onClick={() => { onPlain(); onClose() }}
      />

      {/* Divider before engine profiles */}
      {profiles.length > 0 && (
        <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, margin: '4px 0' }} />
      )}

      {/* Engine profiles */}
      {profiles.map((profile) => {
        const isDefault = profile.id === defaultId
        return (
          <PickerRow
            key={profile.id}
            label={profile.name}
            sublabel={profile.extensions.map((e) => e.split('/').slice(-2).join('/')).join(', ')}
            accentDot={isDefault}
            colors={colors}
            onClick={() => { onProfile(profile.id); onClose() }}
          />
        )
      })}

      {/* Settings footer */}
      <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, margin: '4px 0' }} />
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

// ─── Shared row ───────────────────────────────────────────────────────────────

interface PickerRowProps {
  label: string
  sublabel: string
  /** Show a small accent dot to mark the default profile. */
  accentDot: boolean
  colors: ReturnType<typeof useColors>
  onClick: () => void
}

function PickerRow({ label, sublabel, accentDot, colors, onClick }: PickerRowProps) {
  return (
    <div
      className="flex items-start w-full rounded px-2 py-1.5"
      style={{
        fontSize: 12,
        color: colors.textPrimary,
        background: 'transparent',
        cursor: 'pointer',
        gap: 6,
      }}
      onClick={onClick}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      {/* Accent dot for the default profile */}
      <div style={{
        flexShrink: 0,
        width: 6,
        height: 6,
        borderRadius: '50%',
        marginTop: 4,
        background: accentDot ? colors.accent : 'transparent',
      }} />
      <div className="flex flex-col" style={{ minWidth: 0 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {sublabel && (
          <span style={{
            fontSize: 10,
            color: colors.textTertiary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {sublabel}
          </span>
        )}
      </div>
    </div>
  )
}
