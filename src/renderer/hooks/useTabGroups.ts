import { useMemo } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useThemeStore, getEffectiveTabGroups } from '../theme'
import type { TabState, TabGroupMode, TabGroup } from '../../shared/types'

export interface TabGroupView {
  groupId: string
  label: string
  tabs: TabState[]
  isDefault: boolean
  collapsed: boolean
  selectedTabId: string | null
  order: number
}

export interface TabGroupsResult {
  mode: TabGroupMode
  groups: TabGroupView[]
  ungrouped: TabState[]
}

export function useTabGroups(): TabGroupsResult {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const tabGroups = useThemeStore((s) => s.tabGroups)
  const autoGroupOrder = useThemeStore((s) => s.autoGroupOrder)

  return useMemo(() => {
    if (tabGroupMode === 'off') {
      return { mode: 'off' as const, groups: [], ungrouped: tabs }
    }

    if (tabGroupMode === 'auto') {
      return buildAutoGroups(tabs, activeTabId, autoGroupOrder)
    }

    // Manual mode -- use effective groups (includes defaults when empty)
    const effective = getEffectiveTabGroups(tabGroups)
    return buildManualGroups(tabs, activeTabId, effective)
  }, [tabs, activeTabId, tabGroupMode, tabGroups, autoGroupOrder])
}

function buildAutoGroups(tabs: TabState[], activeTabId: string, autoGroupOrder: string[]): TabGroupsResult {
  // Group tabs by workingDirectory
  const dirMap = new Map<string, TabState[]>()
  for (const tab of tabs) {
    const key = tab.workingDirectory || '~'
    const arr = dirMap.get(key)
    if (arr) arr.push(tab)
    else dirMap.set(key, [tab])
  }

  const groups: TabGroupView[] = []
  const ungrouped: TabState[] = []
  let order = 0

  for (const [dir, dirTabs] of dirMap) {
    if (dirTabs.length < 2) {
      // Single-tab "groups" render as normal pills
      ungrouped.push(...dirTabs)
    } else {
      const label = dir.split('/').pop() || dir
      const selectedTab = dirTabs.find((t) => t.id === activeTabId)
      groups.push({
        groupId: `auto-${dir}`,
        label,
        tabs: dirTabs,
        isDefault: false,
        collapsed: true,
        selectedTabId: selectedTab?.id || dirTabs[0].id,
        order: order++,
      })
    }
  }

  // Sort groups by persisted autoGroupOrder
  if (autoGroupOrder.length > 0) {
    groups.sort((a, b) => {
      const dirA = a.groupId.replace('auto-', '')
      const dirB = b.groupId.replace('auto-', '')
      const idxA = autoGroupOrder.indexOf(dirA)
      const idxB = autoGroupOrder.indexOf(dirB)
      const orderA = idxA >= 0 ? idxA : Infinity
      const orderB = idxB >= 0 ? idxB : Infinity
      return orderA - orderB
    })
  }

  return { mode: 'auto', groups, ungrouped }
}

function buildManualGroups(tabs: TabState[], activeTabId: string, tabGroups: TabGroup[]): TabGroupsResult {
  const groups: TabGroupView[] = []
  const ungrouped: TabState[] = []

  // Build a map of groupId -> tabs
  const groupTabMap = new Map<string, TabState[]>()
  for (const g of tabGroups) {
    groupTabMap.set(g.id, [])
  }

  const defaultGroup = tabGroups.find((g) => g.isDefault) || tabGroups[0]

  for (const tab of tabs) {
    if (tab.groupId && groupTabMap.has(tab.groupId)) {
      groupTabMap.get(tab.groupId)!.push(tab)
    } else if (defaultGroup) {
      // Tabs without a groupId go to the default group
      groupTabMap.get(defaultGroup.id)!.push(tab)
    } else {
      ungrouped.push(tab)
    }
  }

  for (const g of tabGroups) {
    const gTabs = groupTabMap.get(g.id) || []
    if (gTabs.length === 0) continue
    const selectedTab = gTabs.find((t) => t.id === activeTabId)
    groups.push({
      groupId: g.id,
      label: g.label,
      tabs: gTabs,
      isDefault: g.isDefault,
      collapsed: g.collapsed,
      selectedTabId: selectedTab?.id || gTabs[0].id,
      order: g.order,
    })
  }

  // Sort by order
  groups.sort((a, b) => a.order - b.order)

  return { mode: 'manual', groups, ungrouped }
}
