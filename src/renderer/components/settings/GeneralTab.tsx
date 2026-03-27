import React, { useCallback, useState } from 'react'
import { FolderOpen, Trash, PencilSimple, Star, Plus, Lightning, CheckCircle } from '@phosphor-icons/react'
import { useColors, useThemeStore, getEffectiveTabGroups } from '../../theme'
import { useSessionStore } from '../../stores/sessionStore'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import type { GitOpsMode, WorktreeCompletionStrategy, TabGroupMode, TabGroup } from '../../../shared/types'

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
  const allowSettingsEdits = useThemeStore((s) => s.allowSettingsEdits)
  const setAllowSettingsEdits = useThemeStore((s) => s.setAllowSettingsEdits)
  const soundEnabled = useThemeStore((s) => s.soundEnabled)
  const setSoundEnabled = useThemeStore((s) => s.setSoundEnabled)
  const showTodoList = useThemeStore((s) => s.showTodoList)
  const setShowTodoList = useThemeStore((s) => s.setShowTodoList)
  const hideOnExternalLaunch = useThemeStore((s) => s.hideOnExternalLaunch)
  const setHideOnExternalLaunch = useThemeStore((s) => s.setHideOnExternalLaunch)
  const keepExplorerOnCollapse = useThemeStore((s) => s.keepExplorerOnCollapse)
  const setKeepExplorerOnCollapse = useThemeStore((s) => s.setKeepExplorerOnCollapse)
  const keepTerminalOnCollapse = useThemeStore((s) => s.keepTerminalOnCollapse)
  const setKeepTerminalOnCollapse = useThemeStore((s) => s.setKeepTerminalOnCollapse)
  const keepGitPanelOnCollapse = useThemeStore((s) => s.keepGitPanelOnCollapse)
  const setKeepGitPanelOnCollapse = useThemeStore((s) => s.setKeepGitPanelOnCollapse)
  const closeExplorerOnFileOpen = useThemeStore((s) => s.closeExplorerOnFileOpen)
  const setCloseExplorerOnFileOpen = useThemeStore((s) => s.setCloseExplorerOnFileOpen)
  const openMarkdownInPreview = useThemeStore((s) => s.openMarkdownInPreview)
  const setOpenMarkdownInPreview = useThemeStore((s) => s.setOpenMarkdownInPreview)
  const commitCommand = useThemeStore((s) => s.commitCommand)
  const setCommitCommand = useThemeStore((s) => s.setCommitCommand)
  const gitOpsMode = useThemeStore((s) => s.gitOpsMode)
  const setGitOpsMode = useThemeStore((s) => s.setGitOpsMode)
  const worktreeCompletionStrategy = useThemeStore((s) => s.worktreeCompletionStrategy)
  const setWorktreeCompletionStrategy = useThemeStore((s) => s.setWorktreeCompletionStrategy)
  const worktreeBranchDefaults = useThemeStore((s) => s.worktreeBranchDefaults)
  const removeWorktreeBranchDefault = useThemeStore((s) => s.removeWorktreeBranchDefault)
  const worktreeSkipPrTitle = useThemeStore((s) => s.worktreeSkipPrTitle)
  const setWorktreeSkipPrTitle = useThemeStore((s) => s.setWorktreeSkipPrTitle)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const setTabGroupMode = useThemeStore((s) => s.setTabGroupMode)
  const tabGroups = useThemeStore((s) => s.tabGroups)
  const inProgressGroupId = useThemeStore((s) => s.inProgressGroupId)
  const doneGroupId = useThemeStore((s) => s.doneGroupId)

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [newGroupName, setNewGroupName] = useState('')

  const handleTabGroupModeChange = useCallback((newMode: TabGroupMode, oldMode: TabGroupMode) => {
    if (newMode === oldMode) return

    if (newMode === 'manual' && (oldMode === 'off' || oldMode === 'auto')) {
      // Start with empty tabGroups (defaults will apply via getEffectiveTabGroups)
      useThemeStore.getState().setTabGroups([])
      const effectiveGroups = getEffectiveTabGroups([])
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, groupId: effectiveGroups[0].id })),
      }))
      // Auto-assign role IDs to default groups
      const ipGroup = effectiveGroups.find(g => g.label === 'In Progress')
      const doneGroup = effectiveGroups.find(g => g.label === 'Testing')
      if (ipGroup && !useThemeStore.getState().inProgressGroupId) useThemeStore.getState().setInProgressGroupId(ipGroup.id)
      if (doneGroup && !useThemeStore.getState().doneGroupId) useThemeStore.getState().setDoneGroupId(doneGroup.id)
    } else if (newMode === 'auto' && oldMode === 'manual') {
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, groupId: null })),
      }))
    }

    setTabGroupMode(newMode)
  }, [setTabGroupMode])

  const materializeDefaults = useCallback((): TabGroup[] => {
    const currentGroups = useThemeStore.getState().tabGroups
    if (currentGroups.length > 0) return currentGroups
    const defaults = getEffectiveTabGroups([])
    const groups = defaults.map(g => ({
      ...g,
      id: crypto.randomUUID(),
    }))
    useThemeStore.getState().setTabGroups(groups)
    // Reassign tabs from default IDs to new UUIDs
    const defaultIds = defaults.map(d => d.id)
    useSessionStore.setState((s) => ({
      tabs: s.tabs.map((t) => {
        const idx = defaultIds.indexOf(t.groupId || '')
        return idx >= 0 ? { ...t, groupId: groups[idx].id } : t
      }),
    }))
    // Auto-assign role IDs to materialized groups
    const ipGroup = groups.find(g => g.label === 'In Progress')
    const doneGroup = groups.find(g => g.label === 'Testing')
    if (ipGroup && !useThemeStore.getState().inProgressGroupId) useThemeStore.getState().setInProgressGroupId(ipGroup.id)
    if (doneGroup && !useThemeStore.getState().doneGroupId) useThemeStore.getState().setDoneGroupId(doneGroup.id)
    return groups
  }, [])

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

      {gitOpsMode === 'worktree' && Object.keys(worktreeBranchDefaults).length > 0 && (
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

      <SettingSection
        label="Tab Groups"
        description="Off: no grouping. Auto: group by directory. Manual: create and assign groups yourself."
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
          {([{ key: 'off', label: 'Off' }, { key: 'auto', label: 'Auto' }, { key: 'manual', label: 'Manual' }] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleTabGroupModeChange(key as TabGroupMode, tabGroupMode)}
              style={{
                flex: 1,
                padding: '7px 0',
                background: tabGroupMode === key ? colors.accent : 'transparent',
                color: tabGroupMode === key ? '#fff' : colors.textSecondary,
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: tabGroupMode === key ? 600 : 400,
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingSection>

      {tabGroupMode === 'manual' && (() => {
        const displayGroups = getEffectiveTabGroups(tabGroups)
        return (
          <div style={{
            marginTop: 8,
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            {displayGroups.map((group) => (
              <div
                key={group.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderBottom: `1px solid ${colors.containerBorder}`,
                }}
              >
                {/* Star icon -- set as default */}
                <button
                  onClick={() => {
                    const groups = materializeDefaults()
                    const target = groups.find(g => g.label === group.label) || groups[0]
                    useThemeStore.getState().setDefaultTabGroup(target.id)
                  }}
                  title={group.isDefault ? 'Default group' : 'Set as default'}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                    alignItems: 'center',
                    color: group.isDefault ? colors.accent : colors.textTertiary,
                  }}
                >
                  <Star size={14} weight={group.isDefault ? 'fill' : 'regular'} />
                </button>

                {/* Lightning icon -- set as in-progress group */}
                <button
                  onClick={() => {
                    const groups = materializeDefaults()
                    const target = groups.find(g => g.label === group.label) || groups[0]
                    const current = useThemeStore.getState().inProgressGroupId
                    useThemeStore.getState().setInProgressGroupId(current === target.id ? null : target.id)
                  }}
                  title={inProgressGroupId === group.id ? 'In-progress group (click to unset)' : 'Set as in-progress group'}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                    alignItems: 'center',
                    color: inProgressGroupId === group.id ? '#d4a024' : colors.textTertiary,
                  }}
                >
                  <Lightning size={14} weight={inProgressGroupId === group.id ? 'fill' : 'regular'} />
                </button>

                {/* CheckCircle icon -- set as done group */}
                <button
                  onClick={() => {
                    const groups = materializeDefaults()
                    const target = groups.find(g => g.label === group.label) || groups[0]
                    const current = useThemeStore.getState().doneGroupId
                    useThemeStore.getState().setDoneGroupId(current === target.id ? null : target.id)
                  }}
                  title={doneGroupId === group.id ? 'Done group (click to unset)' : 'Set as done group'}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                    alignItems: 'center',
                    color: doneGroupId === group.id ? '#7aac8c' : colors.textTertiary,
                  }}
                >
                  <CheckCircle size={14} weight={doneGroupId === group.id ? 'fill' : 'regular'} />
                </button>

                {/* Label -- double-click to rename, or editable input */}
                {editingGroupId === group.id ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editValue.trim()) {
                        const groups = materializeDefaults()
                        const target = groups.find(g => g.label === group.label) || groups.find(g => g.id === group.id)
                        if (target) useThemeStore.getState().renameTabGroup(target.id, editValue.trim())
                        setEditingGroupId(null)
                      }
                      if (e.key === 'Escape') setEditingGroupId(null)
                    }}
                    onBlur={() => {
                      if (editValue.trim()) {
                        const groups = materializeDefaults()
                        const target = groups.find(g => g.label === group.label) || groups.find(g => g.id === group.id)
                        if (target) useThemeStore.getState().renameTabGroup(target.id, editValue.trim())
                      }
                      setEditingGroupId(null)
                    }}
                    style={{
                      flex: 1,
                      fontSize: 13,
                      background: 'transparent',
                      border: `1px solid ${colors.inputFocusBorder}`,
                      borderRadius: 4,
                      padding: '2px 6px',
                      color: colors.textPrimary,
                      outline: 'none',
                    }}
                  />
                ) : (
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: colors.textPrimary,
                      cursor: 'default',
                    }}
                    onDoubleClick={() => {
                      setEditingGroupId(group.id)
                      setEditValue(group.label)
                    }}
                  >
                    {group.label}
                  </span>
                )}

                {/* Pencil icon */}
                <button
                  onClick={() => {
                    setEditingGroupId(group.id)
                    setEditValue(group.label)
                  }}
                  title="Rename"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                    alignItems: 'center',
                    color: colors.textTertiary,
                    opacity: 0.6,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.6' }}
                >
                  <PencilSimple size={14} />
                </button>

                {/* Trash icon */}
                <button
                  onClick={() => {
                    const groups = materializeDefaults()
                    const target = groups.find(g => g.label === group.label) || groups.find(g => g.id === group.id)
                    if (!target) return
                    // Move tabs from deleted group to the default group
                    const remaining = groups.filter(g => g.id !== target.id)
                    const defaultGroup = remaining.find(g => g.isDefault) || remaining[0]
                    if (defaultGroup) {
                      useSessionStore.setState((s) => ({
                        tabs: s.tabs.map((t) => t.groupId === target.id ? { ...t, groupId: defaultGroup.id } : t),
                      }))
                    } else {
                      // All groups being deleted -- reassign to first default
                      const defaults = getEffectiveTabGroups([])
                      useSessionStore.setState((s) => ({
                        tabs: s.tabs.map((t) => t.groupId === target.id ? { ...t, groupId: defaults[0].id } : t),
                      }))
                    }
                    useThemeStore.getState().deleteTabGroup(target.id)
                  }}
                  title="Delete group"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                    alignItems: 'center',
                    color: colors.textTertiary,
                    opacity: 0.6,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.6' }}
                >
                  <Trash size={14} />
                </button>
              </div>
            ))}

            {/* Add new group row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
              }}
            >
              <Plus size={14} color={colors.accent} style={{ flexShrink: 0 }} />
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newGroupName.trim()) {
                    materializeDefaults()
                    useThemeStore.getState().createTabGroup(newGroupName.trim())
                    setNewGroupName('')
                  }
                  if (e.key === 'Escape') setNewGroupName('')
                }}
                placeholder="New group..."
                style={{
                  flex: 1,
                  fontSize: 13,
                  background: 'transparent',
                  border: 'none',
                  padding: '2px 0',
                  color: colors.textPrimary,
                  outline: 'none',
                }}
              />
            </div>
          </div>
        )
      })()}

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
        label="Allow Settings Edits"
        description="Show an approval card when the agent tries to edit its own settings files, instead of blocking."
        checked={allowSettingsEdits}
        onChange={setAllowSettingsEdits}
        warning="The agent will be able to modify Claude Code settings (CLAUDE.md, settings.json) after your approval."
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

      {/* ── Minimize Behavior ── */}
      <SettingHeading>Minimize Behavior</SettingHeading>

      <SettingToggle
        label="Keep Explorer Open"
        description="Keep the file explorer open when the conversation is minimized."
        checked={keepExplorerOnCollapse}
        onChange={setKeepExplorerOnCollapse}
      />

      <SettingToggle
        label="Keep Console Open"
        description="Keep the terminal console open when the conversation is minimized."
        checked={keepTerminalOnCollapse}
        onChange={setKeepTerminalOnCollapse}
      />

      <SettingToggle
        label="Keep Git Panel Open"
        description="Keep the git panel open when the conversation is minimized."
        checked={keepGitPanelOnCollapse}
        onChange={setKeepGitPanelOnCollapse}
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
    </>
  )
}
