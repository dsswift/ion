import React from 'react'
import { FolderOpen, Trash } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../../theme'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'

export function GeneralTab() {
  const colors = useColors()
  const defaultBaseDirectory = useThemeStore((s) => s.defaultBaseDirectory)
  const setDefaultBaseDirectory = useThemeStore((s) => s.setDefaultBaseDirectory)
  const defaultPermissionMode = useThemeStore((s) => s.defaultPermissionMode)
  const setDefaultPermissionMode = useThemeStore((s) => s.setDefaultPermissionMode)
  const expandOnTabSwitch = useThemeStore((s) => s.expandOnTabSwitch)
  const setExpandOnTabSwitch = useThemeStore((s) => s.setExpandOnTabSwitch)
  const showImplementClearContext = useThemeStore((s) => s.showImplementClearContext)
  const setShowImplementClearContext = useThemeStore((s) => s.setShowImplementClearContext)
  const bashCommandEntry = useThemeStore((s) => s.bashCommandEntry)
  const setBashCommandEntry = useThemeStore((s) => s.setBashCommandEntry)
  const soundEnabled = useThemeStore((s) => s.soundEnabled)
  const setSoundEnabled = useThemeStore((s) => s.setSoundEnabled)
  const closeExplorerOnFileOpen = useThemeStore((s) => s.closeExplorerOnFileOpen)
  const setCloseExplorerOnFileOpen = useThemeStore((s) => s.setCloseExplorerOnFileOpen)
  const openMarkdownInPreview = useThemeStore((s) => s.openMarkdownInPreview)
  const setOpenMarkdownInPreview = useThemeStore((s) => s.setOpenMarkdownInPreview)

  const handleBrowse = async () => {
    const dir = await window.clui.selectDirectory()
    if (dir) setDefaultBaseDirectory(dir)
  }

  return (
    <>
      {/* ── Workspace ── */}
      <SettingHeading first>Workspace</SettingHeading>

      <SettingSection
        label="Default Directory"
        description="New tabs will open in this directory. When empty, defaults to your home directory."
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div
            style={{
              flex: 1,
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 8,
              padding: '8px 12px',
              color: defaultBaseDirectory ? colors.textPrimary : colors.textTertiary,
              fontSize: 13,
              fontFamily: 'monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {defaultBaseDirectory || '~/'}
          </div>
          <button
            onClick={handleBrowse}
            title="Browse..."
            style={{
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 8,
              padding: '8px 10px',
              cursor: 'pointer',
              color: colors.textSecondary,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <FolderOpen size={15} />
            Browse
          </button>
          {defaultBaseDirectory && (
            <button
              onClick={() => setDefaultBaseDirectory('')}
              title="Reset to home directory"
              style={{
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                color: colors.textTertiary,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Trash size={15} />
            </button>
          )}
        </div>
      </SettingSection>

      {/* ── Tabs ── */}
      <SettingHeading>Tabs</SettingHeading>

      <SettingSection
        label="Default Permission Mode"
        description="The permission mode new tabs start with."
      >
        <div
          style={{
            display: 'flex',
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {(['plan', 'auto', 'ask'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setDefaultPermissionMode(mode)}
              style={{
                flex: 1,
                padding: '7px 0',
                background: defaultPermissionMode === mode ? colors.accent : 'transparent',
                color: defaultPermissionMode === mode ? '#fff' : colors.textSecondary,
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: defaultPermissionMode === mode ? 600 : 400,
                textTransform: 'capitalize',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </SettingSection>

      <SettingToggle
        label="Auto-expand on Switch"
        description="Automatically expand the conversation when switching tabs."
        checked={expandOnTabSwitch}
        onChange={setExpandOnTabSwitch}
      />

      {/* ── Behavior ── */}
      <SettingHeading>Behavior</SettingHeading>

      <SettingToggle
        label="Clear Context on Implement"
        description='Show the "Implement, clear context" option when exiting plan mode.'
        checked={showImplementClearContext}
        onChange={setShowImplementClearContext}
      />

      <SettingToggle
        label="Bash Command Entry"
        description="Type ! as the first character to run bash commands directly in the conversation."
        checked={bashCommandEntry}
        onChange={setBashCommandEntry}
      />

      <SettingToggle
        label="Notification Sound"
        description="Play a sound when a task completes."
        checked={soundEnabled}
        onChange={setSoundEnabled}
      />

      {/* ── File Explorer / Editor ── */}
      <SettingHeading>File Explorer</SettingHeading>

      <SettingToggle
        label="Close Explorer on File Open"
        description="Automatically close the file explorer when a file is opened in the editor."
        checked={closeExplorerOnFileOpen}
        onChange={setCloseExplorerOnFileOpen}
      />

      <SettingToggle
        label="Open Markdown in Preview"
        description="Open saved .md files in preview mode by default. New unsaved files always open in edit mode."
        checked={openMarkdownInPreview}
        onChange={setOpenMarkdownInPreview}
      />
    </>
  )
}
