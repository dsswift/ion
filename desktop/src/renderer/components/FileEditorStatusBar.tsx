import React, { useState, useRef, useEffect } from 'react'
import { useColors } from '../theme'
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
          style={{
            background: 'none',
            border: 'none',
            color: colors.textTertiary,
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
            fontFamily: 'inherit',
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
          style={{
            background: 'none',
            border: 'none',
            color: colors.textTertiary,
            cursor: 'pointer',
            padding: '0 4px',
            fontSize: 11,
            fontFamily: 'inherit',
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
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
              padding: '4px 0',
              zIndex: 99999,
            }}
          >
            <button
              onClick={() => { onLanguageChange(null); setShowLangPicker(false) }}
              style={{
                display: 'block',
                width: '100%',
                padding: '4px 10px',
                border: 'none',
                background: languageOverride === null ? colors.surfaceHover : 'transparent',
                color: colors.textPrimary,
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Auto Detect
            </button>
            {ALL_LANGUAGES.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => { onLanguageChange(id); setShowLangPicker(false) }}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '4px 10px',
                  border: 'none',
                  background: languageOverride === id ? colors.surfaceHover : 'transparent',
                  color: colors.textPrimary,
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.background = colors.surfaceHover }}
                onMouseLeave={(e) => {
                  (e.target as HTMLElement).style.background = languageOverride === id ? colors.surfaceHover : 'transparent'
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
