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
