import React from 'react'
import { Trash } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../../theme'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import type { GitOpsMode, WorktreeCompletionStrategy } from '../../../shared/types'

export function GitCategory() {
  const colors = useColors()
  const gitOpsMode = useThemeStore((s) => s.gitOpsMode)
  const setGitOpsMode = useThemeStore((s) => s.setGitOpsMode)
  const worktreeCompletionStrategy = useThemeStore((s) => s.worktreeCompletionStrategy)
  const setWorktreeCompletionStrategy = useThemeStore((s) => s.setWorktreeCompletionStrategy)
  const worktreeSkipPrTitle = useThemeStore((s) => s.worktreeSkipPrTitle)
  const setWorktreeSkipPrTitle = useThemeStore((s) => s.setWorktreeSkipPrTitle)
  const worktreeBranchDefaults = useThemeStore((s) => s.worktreeBranchDefaults)
  const removeWorktreeBranchDefault = useThemeStore((s) => s.removeWorktreeBranchDefault)
  const commitCommand = useThemeStore((s) => s.commitCommand)
  const setCommitCommand = useThemeStore((s) => s.setCommitCommand)
  const claudeCommand = useThemeStore((s) => s.claudeCommand)
  const setClaudeCommand = useThemeStore((s) => s.setClaudeCommand)
  const gitChangesTreeView = useThemeStore((s) => s.gitChangesTreeView)
  const setGitChangesTreeView = useThemeStore((s) => s.setGitChangesTreeView)

  return (
    <>
      <SettingHeading first>Git Operations</SettingHeading>

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

      <SettingToggle
        label="Tree View for Changes"
        description="Group changed files by directory in the git panel."
        checked={gitChangesTreeView}
        onChange={setGitChangesTreeView}
      />

      <SettingHeading>Commands</SettingHeading>

      <SettingSection
        label="Commit Command"
        description="Bash command to run in the terminal instead of prompting the LLM. Leave empty for default behavior."
      >
        <input
          type="text"
          value={commitCommand}
          onChange={(e) => setCommitCommand(e.target.value)}
          placeholder="e.g. commit --smart"
          style={{
            width: '100%',
            padding: '7px 10px',
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, monospace',
            background: colors.surfacePrimary,
            color: colors.textPrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            outline: 'none',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = colors.accent }}
          onBlur={(e) => { e.currentTarget.style.borderColor = colors.containerBorder }}
        />
      </SettingSection>

      <SettingSection
        label="Claude Command"
        description="Command to launch Claude in the terminal. Leave empty for default (claude)."
      >
        <input
          type="text"
          value={claudeCommand}
          onChange={(e) => setClaudeCommand(e.target.value)}
          placeholder="claude"
          style={{
            width: '100%',
            padding: '7px 10px',
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, monospace',
            background: colors.surfacePrimary,
            color: colors.textPrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            outline: 'none',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = colors.accent }}
          onBlur={(e) => { e.currentTarget.style.borderColor = colors.containerBorder }}
        />
      </SettingSection>
    </>
  )
}
