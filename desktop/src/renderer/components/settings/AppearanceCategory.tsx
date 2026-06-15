import React, { useState, useEffect } from 'react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { themes, getTheme } from '../../theme-tokens'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'

let fontCache: string[] | null = null
const fontPromise = window.ion?.listFonts().then((fonts) => { fontCache = fonts }).catch(() => {})

export function AppearanceCategory() {
  const colors = useColors()
  const expandedUI = usePreferencesStore((s) => s.expandedUI)
  const setExpandedUI = usePreferencesStore((s) => s.setExpandedUI)
  const ultraWide = usePreferencesStore((s) => s.ultraWide)
  const setUltraWide = usePreferencesStore((s) => s.setUltraWide)
  const themeMode = usePreferencesStore((s) => s.themeMode)
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode)
  const selectedTheme = usePreferencesStore((s) => s.selectedTheme)
  const setSelectedTheme = usePreferencesStore((s) => s.setSelectedTheme)
  const expandToolResults = usePreferencesStore((s) => s.expandToolResults)
  const setExpandToolResults = usePreferencesStore((s) => s.setExpandToolResults)
  const unifiedTurnView = usePreferencesStore((s) => s.unifiedTurnView)
  const setUnifiedTurnView = usePreferencesStore((s) => s.setUnifiedTurnView)
  const defaultTallConversation = usePreferencesStore((s) => s.defaultTallConversation)
  const setDefaultTallConversation = usePreferencesStore((s) => s.setDefaultTallConversation)
  const defaultTallTerminal = usePreferencesStore((s) => s.defaultTallTerminal)
  const setDefaultTallTerminal = usePreferencesStore((s) => s.setDefaultTallTerminal)
  const defaultTallEngine = usePreferencesStore((s) => s.defaultTallEngine)
  const setDefaultTallEngine = usePreferencesStore((s) => s.setDefaultTallEngine)
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap)
  const setEditorWordWrap = usePreferencesStore((s) => s.setEditorWordWrap)
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize)
  const setEditorFontSize = usePreferencesStore((s) => s.setEditorFontSize)
  const conversationFontSize = usePreferencesStore((s) => s.conversationFontSize)
  const setConversationFontSize = usePreferencesStore((s) => s.setConversationFontSize)
  const closeExplorerOnFileOpen = usePreferencesStore((s) => s.closeExplorerOnFileOpen)
  const setCloseExplorerOnFileOpen = usePreferencesStore((s) => s.setCloseExplorerOnFileOpen)
  const hideOnExternalLaunch = usePreferencesStore((s) => s.hideOnExternalLaunch)
  const setHideOnExternalLaunch = usePreferencesStore((s) => s.setHideOnExternalLaunch)
  const openMarkdownInPreview = usePreferencesStore((s) => s.openMarkdownInPreview)
  const setOpenMarkdownInPreview = usePreferencesStore((s) => s.setOpenMarkdownInPreview)
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily)
  const setTerminalFontFamily = usePreferencesStore((s) => s.setTerminalFontFamily)
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize)
  const setTerminalFontSize = usePreferencesStore((s) => s.setTerminalFontSize)

  const [availableFonts, setAvailableFonts] = useState<string[]>(fontCache || [])
  useEffect(() => {
    if (fontCache) return
    fontPromise.then(() => { if (fontCache) setAvailableFonts(fontCache) })
  }, [])

  // Shared +/- font-size stepper (8–24px). Used by the Editor, Conversation,
  // and Terminal font-size controls so the markup lives in one place.
  const fontStepper = (value: number, onChange: (v: number) => void) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={() => onChange(Math.max(8, value - 1))}
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
        {value}
      </span>
      <button
        onClick={() => onChange(Math.min(24, value + 1))}
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
  )

  return (
    <>
      <SettingHeading first>Layout</SettingHeading>

      <SettingToggle
        label="Full Width"
        description="Expand the UI to use more horizontal space."
        checked={expandedUI}
        onChange={setExpandedUI}
      />

      <SettingToggle
        label="Ultra Wide"
        description="Shift to wider sizes for large external monitors."
        checked={ultraWide}
        onChange={setUltraWide}
      />

      <SettingHeading>Default Tall Mode</SettingHeading>

      <SettingToggle
        label="Conversations"
        description="Open conversation tabs in tall mode."
        checked={defaultTallConversation}
        onChange={setDefaultTallConversation}
      />

      <SettingToggle
        label="Terminal Tabs"
        description="Open terminal tabs in tall mode."
        checked={defaultTallTerminal}
        onChange={setDefaultTallTerminal}
      />

      <SettingToggle
        label="Engine Tabs"
        description="Open engine tabs in tall mode."
        checked={defaultTallEngine}
        onChange={setDefaultTallEngine}
      />

      <SettingHeading>Theme</SettingHeading>

      <SettingSection label="Color Theme" description="Choose a visual theme for the app.">
        <select
          value={selectedTheme}
          onChange={(e) => setSelectedTheme(e.target.value)}
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
            boxSizing: 'border-box' as const,
            cursor: 'pointer',
          }}
        >
          {themes.map((t) => (
            <option key={t.id} value={t.id}>{t.displayName}</option>
          ))}
        </select>
      </SettingSection>

      {!getTheme(selectedTheme).forcedColorScheme && (
        <SettingToggle
          label="Dark Theme"
          description="Toggle between light and dark theme."
          checked={themeMode === 'dark'}
          onChange={(next) => setThemeMode(next ? 'dark' : 'light')}
        />
      )}

      <SettingToggle
        label="Tool Output"
        description="Auto-expand file write and edit results inline."
        checked={expandToolResults}
        onChange={setExpandToolResults}
      />

      <SettingToggle
        label="Unified Turn View"
        description="Group tool calls into a collapsible panel and show assistant text as a continuous block, instead of interleaving tool calls with text."
        checked={unifiedTurnView}
        onChange={setUnifiedTurnView}
      />

      <SettingHeading>File Explorer</SettingHeading>

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

      <SettingToggle
        label="Word Wrap"
        description="Wrap long lines in the editor instead of horizontal scrolling."
        checked={editorWordWrap}
        onChange={setEditorWordWrap}
      />

      <SettingHeading>Editor</SettingHeading>

      <SettingSection description="Editor font size (edit and preview) in pixels.">
        {fontStepper(editorFontSize, setEditorFontSize)}
      </SettingSection>

      <SettingHeading>Conversation</SettingHeading>

      <SettingSection description="Conversation message font size in pixels.">
        {fontStepper(conversationFontSize, setConversationFontSize)}
      </SettingSection>

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
        {fontStepper(terminalFontSize, setTerminalFontSize)}
      </SettingSection>
    </>
  )
}
