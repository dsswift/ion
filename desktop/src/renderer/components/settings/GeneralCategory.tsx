import React, { useState, useEffect } from 'react'
import { FolderOpen, Trash } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'

export function GeneralCategory() {
  const colors = useColors()
  const defaultBaseDirectory = usePreferencesStore((s) => s.defaultBaseDirectory)
  const setDefaultBaseDirectory = usePreferencesStore((s) => s.setDefaultBaseDirectory)
  const defaultPermissionMode = usePreferencesStore((s) => s.defaultPermissionMode)
  const setDefaultPermissionMode = usePreferencesStore((s) => s.setDefaultPermissionMode)
  const bashCommandEntry = usePreferencesStore((s) => s.bashCommandEntry)
  const setBashCommandEntry = usePreferencesStore((s) => s.setBashCommandEntry)
  const allowSettingsEdits = usePreferencesStore((s) => s.allowSettingsEdits)
  const setAllowSettingsEdits = usePreferencesStore((s) => s.setAllowSettingsEdits)
  const enableClaudeCompat = usePreferencesStore((s) => s.enableClaudeCompat)
  const setEnableClaudeCompat = usePreferencesStore((s) => s.setEnableClaudeCompat)
  const soundEnabled = usePreferencesStore((s) => s.soundEnabled)
  const setSoundEnabled = usePreferencesStore((s) => s.setSoundEnabled)
  const showTodoList = usePreferencesStore((s) => s.showTodoList)
  const setShowTodoList = usePreferencesStore((s) => s.setShowTodoList)
  const aiGeneratedTitles = usePreferencesStore((s) => s.aiGeneratedTitles)
  const setAiGeneratedTitles = usePreferencesStore((s) => s.setAiGeneratedTitles)
  const showImplementClearContext = usePreferencesStore((s) => s.showImplementClearContext)
  const setShowImplementClearContext = usePreferencesStore((s) => s.setShowImplementClearContext)

  const handleBrowse = async () => {
    const dir = await window.ion.selectDirectory()
    if (dir) setDefaultBaseDirectory(dir)
  }

  return (
    <>
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
          {(['plan', 'auto'] as const).map((mode) => (
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

      <SettingSection
        label="Backend Mode"
        description="API connects directly to Anthropic. CLI proxies through the Claude CLI. Switching restarts the app; each mode keeps its own tabs and conversations."
      >
        <BackendToggle />
      </SettingSection>

      <SettingHeading>Behavior</SettingHeading>

      <SettingToggle
        label="Bash Command Entry"
        description="Type ! as the first character to run bash commands directly in the conversation."
        checked={bashCommandEntry}
        onChange={setBashCommandEntry}
      />

      <SettingToggle
        label="Allow Settings Edits"
        description="Show an approval card when the agent tries to edit its own settings files, instead of blocking."
        checked={allowSettingsEdits}
        onChange={setAllowSettingsEdits}
        warning="The agent will be able to modify Ion settings (ION.md, engine.json) after your approval."
      />

      <SettingToggle
        label="Claude Compatibility"
        description="Load commands and skills from .claude/ directories in the project and home folder."
        checked={enableClaudeCompat}
        onChange={setEnableClaudeCompat}
      />

      <SettingToggle
        label="Notification Sound"
        description="Play a sound when a task completes."
        checked={soundEnabled}
        onChange={setSoundEnabled}
      />

      <SettingToggle
        label="Show Task List"
        description="Display the agent's todo/task checklist at the bottom of the conversation while working."
        checked={showTodoList}
        onChange={setShowTodoList}
      />

      <SettingToggle
        label="AI Tab Titles"
        description="Use AI to generate descriptive tab titles from your first message. Uses the fast model tier."
        checked={aiGeneratedTitles}
        onChange={setAiGeneratedTitles}
      />

      <SettingToggle
        label="Clear Context on Implement"
        description='Show the "Implement, clear context" option when exiting plan mode.'
        checked={showImplementClearContext}
        onChange={setShowImplementClearContext}
        warning="Advanced feature — not recommended for typical use. Clearing context discards the conversation history that helps the agent maintain continuity."
      />
    </>
  )
}

function BackendToggle() {
  const colors = useColors()
  const [backend, setBackend] = useState<'api' | 'cli' | null>(null)
  const [confirming, setConfirming] = useState<'api' | 'cli' | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    window.ion.getBackend().then(setBackend)
  }, [])

  const handleSwitch = (target: 'api' | 'cli') => {
    if (target === backend || restarting) return
    setConfirming(target)
  }

  const confirmSwitch = () => {
    if (!confirming || restarting) return
    setRestarting(true)
    window.ion.switchBackend(confirming)
  }

  if (!backend) return null

  return (
    <div>
      <div
        style={{
          display: 'flex',
          background: colors.surfacePrimary,
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {(['cli', 'api'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => handleSwitch(mode)}
            style={{
              flex: 1,
              padding: '7px 0',
              background: backend === mode ? colors.accent : 'transparent',
              color: backend === mode ? '#fff' : colors.textSecondary,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: backend === mode ? 600 : 400,
              textTransform: 'uppercase',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {mode}
          </button>
        ))}
      </div>
      {(confirming || restarting) && (
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            fontSize: 12,
            color: colors.textSecondary,
          }}
        >
          {restarting ? (
            <div style={{ color: colors.textPrimary, fontWeight: 500 }}>
              Restarting...
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                Switch to <strong>{confirming!.toUpperCase()}</strong> mode? Conversations from your current mode won't be visible in the new mode. The app will restart.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={confirmSwitch}
                  style={{
                    padding: '5px 12px',
                    background: colors.accent,
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Switch & Restart
                </button>
                <button
                  onClick={() => setConfirming(null)}
                  style={{
                    padding: '5px 12px',
                    background: 'transparent',
                    color: colors.textSecondary,
                    border: `1px solid ${colors.containerBorder}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
