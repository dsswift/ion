/**
 * CommandPalette — shared ⌘K fuzzy jump, mounted in BOTH the overlay and
 * the ATV shell (overlay↔ATV parity mechanism 1: one component, one store).
 * Entries: every tab (select forwards/executes per window role) plus
 * host-injected actions (each surface contributes its own — "Open
 * Visualizer" in the overlay, "Open Overlay" in the ATV, canvas actions...).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { rankEntries, type PaletteEntry } from './command-palette-rank'

export interface CommandPaletteProps {
  /** Host-surface actions appended to the tab entries. */
  actions?: PaletteEntry[]
}

export function CommandPalette(props: CommandPaletteProps): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const tabs = useSessionStore((s) => s.tabs)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        setQuery('')
        setIndex(0)
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
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
        paddingTop: '18vh',
        pointerEvents: 'auto',
        background: 'rgba(0,0,0,0.25)',
      }}
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxHeight: 380,
          display: 'flex',
          flexDirection: 'column',
          background: colors.containerBg,
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 10,
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
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
              setOpen(false)
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
        <div style={{ overflowY: 'auto' }}>
          {ranked.length === 0 && (
            <div style={{ padding: 14, color: colors.textTertiary, fontSize: 12 }}>No matches.</div>
          )}
          {ranked.map(({ entry }, i) => (
            <div
              key={entry.id}
              onClick={() => {
                setOpen(false)
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
              <span style={{ color: colors.textPrimary, fontSize: 13 }}>{entry.label}</span>
              <span style={{ marginLeft: 'auto', color: colors.textTertiary, fontSize: 10 }}>{entry.section}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    layer,
  )
}
