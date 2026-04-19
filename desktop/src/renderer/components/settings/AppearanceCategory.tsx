import React from 'react'
import { useThemeStore } from '../../theme'
import { SettingToggle } from './SettingToggle'
import { SettingHeading } from './SettingHeading'

export function AppearanceCategory() {
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const setExpandedUI = useThemeStore((s) => s.setExpandedUI)
  const ultraWide = useThemeStore((s) => s.ultraWide)
  const setUltraWide = useThemeStore((s) => s.setUltraWide)
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)
  const expandToolResults = useThemeStore((s) => s.expandToolResults)
  const setExpandToolResults = useThemeStore((s) => s.setExpandToolResults)

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
