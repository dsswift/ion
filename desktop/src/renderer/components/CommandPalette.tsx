/**
 * CommandPalette — shared ⌘K fuzzy jump, mounted in BOTH the overlay and
 * the Studio shell (overlay↔Studio parity mechanism 1: one component, one store).
 * Entries: every tab (select forwards/executes per window role) plus
 * host-injected actions (each surface contributes its own — "Open
 * Visualizer" in the overlay, "Open Overlay" in the Studio window, canvas actions...).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { usePaletteEscape } from './command-palette-control'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { rankEntries, type PaletteEntry } from './command-palette-rank'

export interface CommandPaletteProps {
  /** Host-surface actions appended to the tab entries. */
  actions?: PaletteEntry[]
  /** Controlled by unified shortcut dispatcher, never by a component listener. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette(props: CommandPaletteProps): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const tabs = useSessionStore((s) => s.tabs)
  const { open, onOpenChange } = props

  usePaletteEscape(open, onOpenChange)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      inputRef.current?.focus()
    }
  }, [open])

  const entries = useMemo<PaletteEntry[]>(() => {
    const tabEntries: PaletteEntry[] = tabs.map((t) => ({
      id: `tab:${t.id}`,
      label: t.customTitle || t.title,
      keywords: `${t.workingDirectory} ${t.groupId ?? ''}`,
      section: 'Conversations',
      run: () => useSessionStore.getState().selectTab(t.id),
    }))
    return [...tabEntries, ...(props.actions ?? [])]
  }, [tabs, props.actions])

  const ranked = useMemo(() => rankEntries(query, entries), [query, entries])
  const clamped = Math.min(index, Math.max(0, ranked.length - 1))

  if (!open || !layer) return null
  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: 'max(16px, 18vh) 16px 16px',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        background: 'rgba(0,0,0,0.25)', // hardcoded-ok: pure-black modal scrim
      }}
      onClick={() => onOpenChange(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: '100%',
          maxHeight: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          background: colors.containerBg,
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 10,
          boxShadow: colors.popoverShadow,
          overflow: 'hidden',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="Jump to a conversation or action…"
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, ranked.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter' && ranked[clamped]) {
              e.preventDefault()
              onOpenChange(false)
              ranked[clamped].entry.run()
            }
          }}
          style={{
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: colors.textPrimary,
            padding: '12px 14px',
            fontSize: 14,
            borderBottom: `1px solid ${colors.containerBorder}`,
          }}
        />
        <div style={{ overflowY: 'auto', minWidth: 0 }}>
          {ranked.length === 0 && (
            <div style={{ padding: 14, color: colors.textTertiary, fontSize: 12 }}>No matches.</div>
          )}
          {ranked.map(({ entry }, i) => (
            <div
              key={entry.id}
              onClick={() => {
                onOpenChange(false)
                entry.run()
              }}
              onMouseEnter={() => setIndex(i)}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '7px 14px',
                cursor: 'pointer',
                background: i === clamped ? colors.containerBgCollapsed : 'transparent',
              }}
            >
              <span style={{ color: colors.textPrimary, fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>{entry.label}</span>
              <span style={{ marginLeft: 'auto', color: colors.textTertiary, fontSize: 10, flexShrink: 0 }}>{entry.section}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    layer,
  )
}
