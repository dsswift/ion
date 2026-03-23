import React, { useState, useEffect } from 'react'
import { useColors, useThemeStore } from '../../theme'
import { SettingSection } from './SettingSection'

// Pre-fetch font list at module load so it's ready before the tab renders
let fontCache: string[] | null = null
const fontPromise = window.coda?.listFonts().then((fonts) => { fontCache = fonts }).catch(() => {})

export function TerminalTab() {
  const colors = useColors()
  const terminalFontFamily = useThemeStore((s) => s.terminalFontFamily)
  const setTerminalFontFamily = useThemeStore((s) => s.setTerminalFontFamily)
  const terminalFontSize = useThemeStore((s) => s.terminalFontSize)
  const setTerminalFontSize = useThemeStore((s) => s.setTerminalFontSize)

  const [availableFonts, setAvailableFonts] = useState<string[]>(fontCache || [])
  useEffect(() => {
    if (fontCache) return
    fontPromise.then(() => { if (fontCache) setAvailableFonts(fontCache) })
  }, [])

  return (
    <>
      {/* Terminal Font Family */}
      <SettingSection
        label="Terminal Font"
        description="Font family for the terminal panel. Use a Nerd Font for prompt symbol support."
      >
        <select
          value={availableFonts.includes(terminalFontFamily) ? terminalFontFamily : ''}
          onChange={(e) => setTerminalFontFamily(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 10px',
            fontSize: 13,
            fontFamily: 'inherit',
            color: colors.textPrimary,
            background: colors.surfacePrimary,
            border: `1px solid ${colors.inputBorder}`,
            borderRadius: 8,
            outline: 'none',
            boxSizing: 'border-box',
            cursor: 'pointer',
          }}
        >
          {!availableFonts.includes(terminalFontFamily) && (
            <option value="">{terminalFontFamily}</option>
          )}
          {availableFonts.map((font) => (
            <option key={font} value={font}>{font}</option>
          ))}
        </select>
      </SettingSection>

      {/* Terminal Font Size */}
      <SettingSection description="Font size in pixels.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setTerminalFontSize(Math.max(8, terminalFontSize - 1))}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: `1px solid ${colors.inputBorder}`,
              background: colors.surfacePrimary,
              color: colors.textPrimary,
              fontSize: 16,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            -
          </button>
          <span style={{ color: colors.textPrimary, fontSize: 13, minWidth: 24, textAlign: 'center' }}>
            {terminalFontSize}
          </span>
          <button
            onClick={() => setTerminalFontSize(Math.min(24, terminalFontSize + 1))}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: `1px solid ${colors.inputBorder}`,
              background: colors.surfacePrimary,
              color: colors.textPrimary,
              fontSize: 16,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            +
          </button>
        </div>
      </SettingSection>
    </>
  )
}
