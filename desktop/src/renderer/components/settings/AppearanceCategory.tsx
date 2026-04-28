import React from 'react'
import { usePreferencesStore } from '../../preferences'
import { SettingToggle } from './SettingToggle'
import { SettingHeading } from './SettingHeading'

export function AppearanceCategory() {
  const expandedUI = usePreferencesStore((s) => s.expandedUI)
  const setExpandedUI = usePreferencesStore((s) => s.setExpandedUI)
  const ultraWide = usePreferencesStore((s) => s.ultraWide)
  const setUltraWide = usePreferencesStore((s) => s.setUltraWide)
  const themeMode = usePreferencesStore((s) => s.themeMode)
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode)
  const expandToolResults = usePreferencesStore((s) => s.expandToolResults)
  const setExpandToolResults = usePreferencesStore((s) => s.setExpandToolResults)
  const defaultTallConversation = usePreferencesStore((s) => s.defaultTallConversation)
  const setDefaultTallConversation = usePreferencesStore((s) => s.setDefaultTallConversation)
  const defaultTallTerminal = usePreferencesStore((s) => s.defaultTallTerminal)
  const setDefaultTallTerminal = usePreferencesStore((s) => s.setDefaultTallTerminal)
  const defaultTallEngine = usePreferencesStore((s) => s.defaultTallEngine)
  const setDefaultTallEngine = usePreferencesStore((s) => s.setDefaultTallEngine)

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

      <SettingToggle
        label="Dark Theme"
        description="Toggle between light and dark theme."
        checked={themeMode === 'dark'}
        onChange={(next) => setThemeMode(next ? 'dark' : 'light')}
      />

      <SettingToggle
        label="Tool Output"
        description="Auto-expand file write and edit results inline."
        checked={expandToolResults}
        onChange={setExpandToolResults}
      />
    </>
  )
}
