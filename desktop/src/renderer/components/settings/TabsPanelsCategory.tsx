import React, { useCallback, useState } from 'react'
import { Trash, PencilSimple, Star, Plus, Lightning, CheckCircle } from '@phosphor-icons/react'
import { useColors, useThemeStore, getEffectiveTabGroups } from '../../theme'
import { useSessionStore } from '../../stores/sessionStore'
import { SettingToggle } from './SettingToggle'
import { SettingSection } from './SettingSection'
import { SettingHeading } from './SettingHeading'
import type { TabGroupMode, TabGroup } from '../../../shared/types'

export function TabsPanelsCategory() {
  const colors = useColors()
  const expandOnTabSwitch = useThemeStore((s) => s.expandOnTabSwitch)
  const setExpandOnTabSwitch = useThemeStore((s) => s.setExpandOnTabSwitch)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const setTabGroupMode = useThemeStore((s) => s.setTabGroupMode)
  const tabGroups = useThemeStore((s) => s.tabGroups)
  const inProgressGroupId = useThemeStore((s) => s.inProgressGroupId)
  const doneGroupId = useThemeStore((s) => s.doneGroupId)
  const keepExplorerOnCollapse = useThemeStore((s) => s.keepExplorerOnCollapse)
  const setKeepExplorerOnCollapse = useThemeStore((s) => s.setKeepExplorerOnCollapse)
  const keepTerminalOnCollapse = useThemeStore((s) => s.keepTerminalOnCollapse)
  const setKeepTerminalOnCollapse = useThemeStore((s) => s.setKeepTerminalOnCollapse)
  const keepGitPanelOnCollapse = useThemeStore((s) => s.keepGitPanelOnCollapse)
  const setKeepGitPanelOnCollapse = useThemeStore((s) => s.setKeepGitPanelOnCollapse)

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [newGroupName, setNewGroupName] = useState('')

  const handleTabGroupModeChange = useCallback((newMode: TabGroupMode, oldMode: TabGroupMode) => {
    if (newMode === oldMode) return

    if (newMode === 'manual' && (oldMode === 'off' || oldMode === 'auto')) {
      useThemeStore.getState().setTabGroups([])
      const effectiveGroups = getEffectiveTabGroups([])
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, groupId: effectiveGroups[0].id })),
      }))
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
    const defaultIds = defaults.map(d => d.id)
    useSessionStore.setState((s) => ({
      tabs: s.tabs.map((t) => {
        const idx = defaultIds.indexOf(t.groupId || '')
        return idx >= 0 ? { ...t, groupId: groups[idx].id } : t
      }),
    }))
    const ipGroup = groups.find(g => g.label === 'In Progress')
    const doneGroup = groups.find(g => g.label === 'Testing')
    if (ipGroup && !useThemeStore.getState().inProgressGroupId) useThemeStore.getState().setInProgressGroupId(ipGroup.id)
    if (doneGroup && !useThemeStore.getState().doneGroupId) useThemeStore.getState().setDoneGroupId(doneGroup.id)
    return groups
  }, [])

  return (
    <>
      <SettingHeading first>Tabs</SettingHeading>

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
            marginTop: 4,
            marginBottom: 14,
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

                <button
                  onClick={() => {
                    const groups = materializeDefaults()
                    const target = groups.find(g => g.label === group.label) || groups.find(g => g.id === group.id)
                    if (!target) return
                    const remaining = groups.filter(g => g.id !== target.id)
                    const defaultGroup = remaining.find(g => g.isDefault) || remaining[0]
                    if (defaultGroup) {
                      useSessionStore.setState((s) => ({
                        tabs: s.tabs.map((t) => t.groupId === target.id ? { ...t, groupId: defaultGroup.id } : t),
                      }))
                    } else {
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
    </>
  )
}
