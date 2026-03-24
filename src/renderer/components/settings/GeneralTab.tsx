import React from 'react'
import { FolderOpen, Trash } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../../theme'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import type { GitOpsMode, WorktreeCompletionStrategy } from '../../../shared/types'

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
  const gitOpsMode = useThemeStore((s) => s.gitOpsMode)
  const setGitOpsMode = useThemeStore((s) => s.setGitOpsMode)
  const worktreeCompletionStrategy = useThemeStore((s) => s.worktreeCompletionStrategy)
  const setWorktreeCompletionStrategy = useThemeStore((s) => s.setWorktreeCompletionStrategy)
  const worktreeBranchDefaults = useThemeStore((s) => s.worktreeBranchDefaults)
  const removeWorktreeBranchDefault = useThemeStore((s) => s.removeWorktreeBranchDefault)
  const worktreeSkipPrTitle = useThemeStore((s) => s.worktreeSkipPrTitle)
  const setWorktreeSkipPrTitle = useThemeStore((s) => s.setWorktreeSkipPrTitle)

  const handleBrowse = async () => {
    const dir = await window.coda.selectDirectory()
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

      {/* ── Git Operations ── */}
      <SettingHeading>Git Operations</SettingHeading>

      <SettingSection
        label="GitOps Mode"
        description="Manual: no automatic git operations. Worktrees: each new tab gets an isolated worktree branch."
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
          {(['manual', 'worktree'] as GitOpsMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setGitOpsMode(mode)}
              style={{
                flex: 1,
                padding: '7px 0',
                background: gitOpsMode === mode ? colors.accent : 'transparent',
                color: gitOpsMode === mode ? '#fff' : colors.textSecondary,
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: gitOpsMode === mode ? 600 : 400,
                textTransform: 'capitalize',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {mode === 'manual' ? 'Manual' : 'Worktrees'}
            </button>
          ))}
        </div>
      </SettingSection>

      {gitOpsMode === 'worktree' && (
        <>
          <SettingSection
            label="Completion Strategy"
            description="How finished worktree work is integrated back into the source branch."
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
              {([{ key: 'merge', label: 'Merge (--no-ff)' }, { key: 'pr', label: 'Pull Request' }] as const).map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setWorktreeCompletionStrategy(key as WorktreeCompletionStrategy)}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    background: worktreeCompletionStrategy === key ? colors.accent : 'transparent',
                    color: worktreeCompletionStrategy === key ? '#fff' : colors.textSecondary,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: worktreeCompletionStrategy === key ? 600 : 400,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </SettingSection>

          {worktreeCompletionStrategy === 'pr' && (
            <SettingToggle
              label="Skip PR Title Prompt"
              description="Always use the auto-generated branch name for PR titles without prompting."
              checked={worktreeSkipPrTitle}
              onChange={setWorktreeSkipPrTitle}
            />
          )}

          {Object.keys(worktreeBranchDefaults).length > 0 && (
            <SettingSection
              label="Branch Defaults"
              description="Saved default source branches per directory. Remove entries to show the branch picker again."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {Object.entries(worktreeBranchDefaults).map(([dir, branch]) => (
                  <div
                    key={dir}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: colors.surfacePrimary,
                      border: `1px solid ${colors.containerBorder}`,
                      borderRadius: 8,
                      padding: '6px 10px',
                    }}
                  >
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontSize: 12, color: colors.textPrimary, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {dir.replace(/^\/Users\/[^/]+/, '~')}
                      </div>
                      <div style={{ fontSize: 11, color: colors.textTertiary, marginTop: 1 }}>
                        {branch}
                      </div>
                    </div>
                    <button
                      onClick={() => removeWorktreeBranchDefault(dir)}
                      title="Remove default"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: colors.textTertiary,
                        padding: 4,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </SettingSection>
          )}
        </>
      )}

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
        warning="Advanced feature — not recommended for typical use. Clearing context discards the conversation history that helps Claude maintain continuity."
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
