import React from 'react'
import { useThemeStore } from '../../theme'
import { SettingToggle } from './SettingToggle'

export function AppearanceTab() {
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const setExpandedUI = useThemeStore((s) => s.setExpandedUI)
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)
  const expandToolResults = useThemeStore((s) => s.expandToolResults)
  const setExpandToolResults = useThemeStore((s) => s.setExpandToolResults)

  return (
    <>
      <SettingToggle
        label="Full Width"
        description="Expand the UI to use more horizontal space."
        checked={expandedUI}
        onChange={setExpandedUI}
      />

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
