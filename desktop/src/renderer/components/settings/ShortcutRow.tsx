/**
 * ShortcutRow — single editable row in the keyboard-shortcuts settings panel.
 *
 * Renders:
 *   - The command description (left).
 *   - The resolved chord (right), styled differently when customized.
 *   - A "Custom" badge when the binding differs from the catalog default.
 *   - A conflict warning when this chord is shared with another command.
 *   - Click-to-capture: clicking the chord cell enters capture mode ("Press
 *     keys…"), the next keydown is read and written via setKeyboardShortcut.
 *   - A per-row Reset button that restores the catalog default.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useColors } from '../../theme'
import { formatChord, parseChord } from '../../shortcuts/chord'
import type { ShortcutEntry } from '../../shortcuts/shortcut-catalog'
import type { Chord } from '../../shortcuts/chord'

interface ShortcutRowProps {
  entry: ShortcutEntry
  resolvedChord: Chord | null
  isCustom: boolean
  conflictsWith: string | null
  onSet: (commandId: string, chord: string) => void
  onReset: (commandId: string) => void
}

/** Convert a KeyboardEvent to a chord string in the catalog format. */
function eventToChordString(e: KeyboardEvent): string | null {
  // Ignore modifier-only keypresses.
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null
  const parts: string[] = []
  if (e.metaKey || (e.ctrlKey && !e.metaKey)) parts.push(e.metaKey ? 'Mod' : 'Ctrl')
  if (e.ctrlKey && e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.key)
  return parts.join('+')
}

export function ShortcutRow({ entry, resolvedChord, isCustom, conflictsWith, onSet, onReset }: ShortcutRowProps) {
  const colors = useColors()
  const [capturing, setCapturing] = useState(false)
  const captureRef = useRef<((e: KeyboardEvent) => void) | null>(null)

  const startCapture = useCallback(() => {
    setCapturing(true)
  }, [])

  const _cancelCapture = useCallback(() => {
    setCapturing(false)
  }, [])

  // Attach/detach the keydown capture listener.
  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      const chord = eventToChordString(e)
      if (!chord) return
      // Validate before passing up.
      if (!parseChord(chord)) return
      onSet(entry.id, chord)
      setCapturing(false)
    }
    captureRef.current = handler
    document.addEventListener('keydown', handler, true)
    return () => {
      document.removeEventListener('keydown', handler, true)
      captureRef.current = null
    }
  }, [capturing, entry.id, onSet])

  // Click outside cancels capture.
  useEffect(() => {
    if (!capturing) return
    const handleMouseDown = (_e: MouseEvent) => {
      setCapturing(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [capturing])

  const chordDisplay = resolvedChord ? formatChord(
    [
      resolvedChord.mod ? 'Mod' : '',
      resolvedChord.ctrl ? 'Ctrl' : '',
      resolvedChord.shift ? 'Shift' : '',
      resolvedChord.alt ? 'Alt' : '',
      resolvedChord.key,
    ].filter(Boolean).join('+'),
  ) : '—'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '6px 0',
        borderBottom: `1px solid ${colors.containerBorder}`,
        gap: 8,
      }}
    >
      {/* Description */}
      <span style={{ flex: 1, fontSize: 13, color: colors.textPrimary }}>
        {entry.description}
      </span>

      {/* Conflict badge */}
      {conflictsWith && (
        <span
          title={`Conflict with: ${conflictsWith}`}
          style={{
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 4,
            background: '#c4706022',
            color: '#c47060',
            border: '1px solid #c4706055',
            flexShrink: 0,
          }}
        >
          conflict
        </span>
      )}

      {/* Custom badge */}
      {isCustom && !conflictsWith && (
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 4,
            background: colors.accent + '22',
            color: colors.accent,
            border: `1px solid ${colors.accent}55`,
            flexShrink: 0,
          }}
        >
          custom
        </span>
      )}

      {/* Chord capture button */}
      <button
        onClick={startCapture}
        onMouseDown={(e) => { if (capturing) e.stopPropagation() }}
        style={{
          fontSize: 12,
          padding: '3px 10px',
          borderRadius: 6,
          border: `1px solid ${capturing ? colors.accent : colors.inputBorder}`,
          background: capturing ? colors.accent + '22' : colors.surfacePrimary,
          color: capturing ? colors.accent : colors.textSecondary,
          cursor: 'pointer',
          fontFamily: 'monospace',
          minWidth: 90,
          textAlign: 'center',
          flexShrink: 0,
          transition: 'border-color 0.1s, background 0.1s',
        }}
      >
        {capturing ? 'Press keys…' : chordDisplay}
      </button>

      {/* Per-row reset button (only when customized) */}
      {isCustom && (
        <button
          onClick={(e) => { e.stopPropagation(); onReset(entry.id) }}
          style={{
            fontSize: 11,
            padding: '2px 7px',
            borderRadius: 5,
            border: `1px solid ${colors.inputBorder}`,
            background: 'transparent',
            color: colors.textTertiary,
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title="Reset to default"
        >
          Reset
        </button>
      )}
    </div>
  )
}
