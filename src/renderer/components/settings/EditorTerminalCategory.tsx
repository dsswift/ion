import React, { useState, useEffect } from 'react'
import { useColors, useThemeStore } from '../../theme'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'

// Pre-fetch font list at module load so it's ready before the category renders
let fontCache: string[] | null = null
const fontPromise = window.coda?.listFonts().then((fonts) => { fontCache = fonts }).catch(() => {})

export function EditorTerminalCategory() {
  const colors = useColors()
  const closeExplorerOnFileOpen = useThemeStore((s) => s.closeExplorerOnFileOpen)
  const setCloseExplorerOnFileOpen = useThemeStore((s) => s.setCloseExplorerOnFileOpen)
  const hideOnExternalLaunch = useThemeStore((s) => s.hideOnExternalLaunch)
  const setHideOnExternalLaunch = useThemeStore((s) => s.setHideOnExternalLaunch)
  const openMarkdownInPreview = useThemeStore((s) => s.openMarkdownInPreview)
  const setOpenMarkdownInPreview = useThemeStore((s) => s.setOpenMarkdownInPreview)
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
      <SettingHeading first>File Explorer</SettingHeading>

      <SettingToggle
        label="Close Explorer on File Open"
        description="Automatically close the file explorer when a file is opened in the editor."
        checked={closeExplorerOnFileOpen}
        onChange={setCloseExplorerOnFileOpen}
      />

      <SettingToggle
        label="Close Explorer on External Launch"
        description="Close the file explorer when using Reveal in Finder or Open in Native App."
        checked={hideOnExternalLaunch}
        onChange={setHideOnExternalLaunch}
      />

      <SettingToggle
        label="Open Markdown in Preview"
        description="Open saved .md files in preview mode by default. New unsaved files always open in edit mode."
        checked={openMarkdownInPreview}
        onChange={setOpenMarkdownInPreview}
      />

      <SettingHeading>Terminal</SettingHeading>

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
