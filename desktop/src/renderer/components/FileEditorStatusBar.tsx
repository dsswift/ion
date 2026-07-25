import React, { useState, useRef, useEffect } from 'react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { getLanguageLabel, ALL_LANGUAGES } from './FileEditorShared'
import type { CursorPosition } from './FileEditorCodeMirror'

interface FileEditorStatusBarProps {
  fileName: string
  cursorPos: CursorPosition
  /** Override language label for this file (null = auto-detect from filename) */
  languageOverride: string | null
  onLanguageChange: (langId: string | null) => void
  onGoToLine?: () => void
}

/** Language-picker entry with the standard hover/pressed/selected cascade. */
function LangPickerItem({
  label,
  selected,
  onSelect,
  colors,
}: {
  label: string
  selected: boolean
  onSelect: () => void
  colors: ReturnType<typeof useColors>
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onSelect}
      className="ion-focusable"
      {...handlers}
      style={{
        display: 'block',
        width: '100%',
        padding: '4px 10px',
        border: 'none',
        background: interactiveBg(colors, { hover, pressed, selected }),
        color: colors.textPrimary,
        fontWeight: selected ? 500 : undefined,
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 11,
        transition: `background ${transitions.base}`,
      }}
    >
      {label}
    </button>
  )
}

/**
 * Thin status bar at the bottom of the file editor panel.
 * Shows line/col, language, indent info, and encoding.
 */
export function FileEditorStatusBar({
  fileName,
  cursorPos,
  languageOverride,
  onLanguageChange,
  onGoToLine,
}: FileEditorStatusBarProps) {
  const colors = useColors()
  const [showLangPicker, setShowLangPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const gotoBtn = useInteractiveState()
  const langBtn = useInteractiveState()

  const langLabel = languageOverride ?? getLanguageLabel(fileName)

  // Close language picker on click-away
  useEffect(() => {
    if (!showLangPicker) return
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowLangPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick, true)
    return () => document.removeEventListener('mousedown', handleClick, true)
  }, [showLangPicker])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 22,
        minHeight: 22,
        padding: '0 10px',
        background: colors.surfacePrimary,
        borderTop: `1px solid ${colors.containerBorder}`,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 11,
        color: colors.textTertiary,
        userSelect: 'none',
      }}
    >
      {/* Left side: line/col */}
      <div style={{ display: 'flex', gap: 12 }}>
        <button
          onClick={onGoToLine}
          className="ion-focusable"
          {...gotoBtn.handlers}
          style={{
            background: interactiveBg(colors, gotoBtn),
            border: 'none',
            borderRadius: 4,
            color: colors.textTertiary,
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
            fontFamily: 'inherit',
            transition: `background ${transitions.base}`,
          }}
          title="Go to Line (⌘G)"
        >
          Ln {cursorPos.line}, Col {cursorPos.col}
        </button>
        <span>Spaces: 2</span>
        <span>UTF-8</span>
      </div>

      {/* Right side: language selector */}
      <div style={{ position: 'relative' }} ref={pickerRef}>
        <button
          onClick={() => setShowLangPicker(!showLangPicker)}
          className="ion-focusable"
          {...langBtn.handlers}
          style={{
            background: interactiveBg(colors, langBtn),
            border: 'none',
            borderRadius: 4,
            color: colors.textTertiary,
            cursor: 'pointer',
            padding: '0 4px',
            fontSize: 11,
            fontFamily: 'inherit',
            transition: `background ${transitions.base}`,
          }}
          title="Select language mode"
        >
          {langLabel}
        </button>
        {showLangPicker && (
          <div
            style={{
              position: 'absolute',
              bottom: 24,
              right: 0,
              width: 180,
              maxHeight: 240,
              overflowY: 'auto',
              background: colors.containerBg,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 8,
              boxShadow: colors.popoverShadow,
              padding: '4px 0',
              zIndex: 99999,
            }}
          >
            <LangPickerItem
              label="Auto Detect"
              selected={languageOverride === null}
              onSelect={() => { onLanguageChange(null); setShowLangPicker(false) }}
              colors={colors}
            />
            {ALL_LANGUAGES.map(({ id, label }) => (
              <LangPickerItem
                key={id}
                label={label}
                selected={languageOverride === id}
                onSelect={() => { onLanguageChange(id); setShowLangPicker(false) }}
                colors={colors}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
