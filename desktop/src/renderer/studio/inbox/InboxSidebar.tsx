import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsInLineVertical, ArrowsOutLineVertical, CaretDown, CaretRight, Folder, MagnifyingGlass, NotePencil, SortAscending } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useInboxPartition } from './useInboxPartition'
import { InboxRow, type InboxRowVariant } from './InboxRow'
import { fuzzyMatchCommand } from '../../../shared/fuzzy-match'
import { NewConversationPicker } from '../../components/NewConversationPicker'
import { InboxControlButton, InboxProjectScopePicker, InboxSortPicker, type InboxSortOrder } from './InboxControls'
import { inboxProjectFor } from './inbox-grouping'
import { partitionSettled } from './settled-history'
import { SettledHistoryView } from './SettledHistoryView'
import { InboxNavigatorGroups } from './InboxNavigatorGroups'
import { buildInboxNavigator, inboxNavigatorProjectFor } from './inbox-navigator'
import { orderInboxTabs } from './inbox-collapse'
import { loadProjectSelection, saveProjectSelection, type InboxProjectSelection } from './project-selection'
import { rInfo } from '../../rendererLogger'
import { settledRecordRestorableFromInventory } from '../../stores/settled-worktree'
import { useColors } from '../../theme'
import type { TabState } from '../../../shared/types'

const SETTLED_INITIAL = 10
const SETTLED_PAGE = 25
const SNOOZED_EXPANDED_KEY = 'ion:inbox:snoozed-expanded'
const SETTLED_EXPANDED_KEY = 'ion:inbox:settled-expanded'
const ACTIVE_COLLAPSED_KEY = 'ion:inbox:active-collapsed'
const SNOOZED_COLLAPSED_KEY = 'ion:inbox:snoozed-collapsed'
const PROJECT_FILTER_KEY = 'ion:inbox:project-filter'
const SORT_ORDER_KEY = 'ion:inbox:sort-order'

function savedBoolean(key: string, fallback: boolean): boolean {
  const stored = localStorage.getItem(key)
  return stored == null ? fallback : stored === 'true'
}
function savedSet(key: string): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : [])
  } catch { return new Set() }
}
function savedProjectFilter(): InboxProjectSelection { return loadProjectSelection(localStorage.getItem(PROJECT_FILTER_KEY)) }
function savedSortOrder(): InboxSortOrder {
  const value = localStorage.getItem(SORT_ORDER_KEY)
  return value === 'created' || value === 'title' || value === 'activity' ? value : 'activity'
}
function settledOrder(tabs: readonly TabState[]): TabState[] {
  return [...tabs].sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0) || left.id.localeCompare(right.id))
}

export function InboxSidebar(): React.JSX.Element {
  const colors = useColors()
  const partition = useInboxPartition()
  const benches = useSessionStore((state) => state.benchWorkspaces)
  const inventory = useSessionStore((state) => state.worktreeInventory)
  const settledHistory = useSessionStore((state) => state.settledHistory)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<InboxProjectSelection>(savedProjectFilter)
  const [sortOrder, setSortOrder] = useState<InboxSortOrder>(savedSortOrder)
  const [projectAnchor, setProjectAnchor] = useState<{ x: number; y: number } | null>(null)
  const [sortAnchor, setSortAnchor] = useState<{ x: number; y: number } | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [snoozedOpen, setSnoozedOpen] = useState(() => savedBoolean(SNOOZED_EXPANDED_KEY, false))
  const [settledOpen, setSettledOpen] = useState(() => savedBoolean(SETTLED_EXPANDED_KEY, true))
  const [settledShown, setSettledShown] = useState(SETTLED_INITIAL)
  const [activeCollapsed, setActiveCollapsed] = useState<Set<string>>(() => savedSet(ACTIVE_COLLAPSED_KEY))
  const [snoozedCollapsed, setSnoozedCollapsed] = useState<Set<string>>(() => savedSet(SNOOZED_COLLAPSED_KEY))
  const [showHistory, setShowHistory] = useState(false)
  const [selectedBench, setSelectedBench] = useState<Record<string, string>>({})
  const composeButton = useRef<HTMLButtonElement>(null)
  const projectButton = useRef<HTMLButtonElement>(null)
  const sortButton = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Memoized because these arrays are the memo inputs for every navigator below
  // AND the input to the workspace-refresh effect. Rebuilding them inline gave
  // them a new identity on every render, so `allProjects` never hit its memo and
  // the effect fired every render — and since the refresh writes the store this
  // component subscribes to, that was a self-sustaining render loop.
  const visible = useCallback((tabs: readonly TabState[]): TabState[] => tabs.filter((tab) => {
    const project = inboxNavigatorProjectFor(tab, benches, inventory)
    if (projectFilter.size > 0 && !projectFilter.has(project.key)) return false
    if (!query.trim()) return true
    return fuzzyMatchCommand(query, tab.customTitle || tab.title) !== null || fuzzyMatchCommand(query, project.name) !== null
  }), [projectFilter, query, benches, inventory])
  const activeTabs = useMemo(() => visible([...partition.pinned, ...partition.inbox]), [visible, partition.pinned, partition.inbox])
  const snoozedTabs = useMemo(() => visible(partition.snoozed), [visible, partition.snoozed])
  const allSettled = useMemo(() => visible([...partition.settled, ...settledHistory]), [visible, partition.settled, settledHistory])
  const { recent: recentSettled, history: historySettled } = useMemo(() => partitionSettled(settledOrder(allSettled), Date.now()), [allSettled])
  const activeNavigator = useMemo(() => buildInboxNavigator(orderInboxTabs(activeTabs, sortOrder), benches, inventory, new Map(Object.entries(selectedBench)), projectFilter), [activeTabs, benches, inventory, sortOrder, selectedBench, projectFilter])
  const snoozedNavigator = useMemo(() => buildInboxNavigator(orderInboxTabs(snoozedTabs, sortOrder), benches, inventory, new Map(Object.entries(selectedBench)), projectFilter), [snoozedTabs, benches, inventory, sortOrder, selectedBench, projectFilter])
  const allProjects = useMemo(() => buildInboxNavigator([...partition.pinned, ...partition.inbox, ...partition.snoozed], benches, inventory, new Map(Object.entries(selectedBench))), [partition.pinned, partition.inbox, partition.snoozed, benches, inventory, selectedBench])
  const projectOptions = allProjects.map((node) => ({ key: node.project.key, name: node.project.name, count: node.flatTabs.length + node.groups.reduce((sum, group) => sum + group.tabs.length, 0) }))
  const searching = query.trim().length > 0
  const searchRows = searching ? orderInboxTabs([...activeTabs, ...snoozedTabs, ...recentSettled], sortOrder) : []

  useEffect(() => { localStorage.setItem(ACTIVE_COLLAPSED_KEY, JSON.stringify([...activeCollapsed])) }, [activeCollapsed])
  useEffect(() => { localStorage.setItem(SNOOZED_COLLAPSED_KEY, JSON.stringify([...snoozedCollapsed])) }, [snoozedCollapsed])
  useEffect(() => { localStorage.setItem(SNOOZED_EXPANDED_KEY, String(snoozedOpen)) }, [snoozedOpen])
  useEffect(() => { localStorage.setItem(SETTLED_EXPANDED_KEY, String(settledOpen)) }, [settledOpen])
  useEffect(() => { localStorage.setItem(SORT_ORDER_KEY, sortOrder) }, [sortOrder])
  useEffect(() => {
    const stored = saveProjectSelection(projectFilter)
    if (stored) localStorage.setItem(PROJECT_FILTER_KEY, stored)
    else localStorage.removeItem(PROJECT_FILTER_KEY)
    rInfo('inbox', 'project scope applied', {
      project_scope: projectFilter.size === 0 ? 'all' : [...projectFilter],
    })
  }, [projectFilter])
  // Keyed on the project-key TOKEN, never on `allProjects` identity. Memoizing
  // the navigator inputs above is what makes the memo hit, but a dep on an
  // object identity is one accidental un-memoized input away from firing every
  // render again — and this effect writes the store the component reads, so
  // that misfire is a CPU-pinning loop rather than a wasted render. The token
  // only changes when the set of projects actually changes.
  // JSON-encoded rather than delimiter-joined: a project key is a repo path,
  // and there is no separator character a path cannot legally contain.
  const projectKeyToken = JSON.stringify(allProjects.map((node) => node.project.key))
  useEffect(() => {
    const refresh = useSessionStore.getState().refreshWorkspaceViews
    for (const key of JSON.parse(projectKeyToken) as string[]) void refresh(key)
  }, [projectKeyToken])

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string): void => set((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const collapseAll = (): void => {
    const keys = allProjects.flatMap((project) => [`project:${project.project.key}`, ...project.groups.map((group) => `group:card:${group.key}`), ...project.groups.map((group) => `group:slim:${group.key}`)])
    setActiveCollapsed(new Set(keys.filter((key) => key.includes(':card:') || key.startsWith('project:'))))
    setSnoozedCollapsed(new Set(keys.filter((key) => key.includes(':slim:') || key.startsWith('project:'))))
  }
  const expandAll = (): void => { setActiveCollapsed(new Set()); setSnoozedCollapsed(new Set()) }
  const row = (tab: TabState, variant: InboxRowVariant, projectName: string): React.JSX.Element => <InboxRow key={`${tab.id}:${variant}`} tab={tab} variant={variant} projectName={projectName} benches={benches} inventory={inventory} rightBoundaryRef={sidebarRef} unread={partition.meta.get(tab.id)?.unread ?? false} woke={partition.meta.get(tab.id)?.wokeAt != null} backgroundLiveness={partition.meta.get(tab.id)?.backgroundLiveness ?? null} />
  const openSettledReview = (tab: TabState): void => {
    const state = useSessionStore.getState()
    if (state.settledHistory.some((record) => record.id === tab.id)) void state.restoreSettledHistoryTab(tab.id)
    else state.selectTab(tab.id)
  }
  const settledRow = (tab: TabState): React.JSX.Element => {
    const canRestore = settledRecordRestorableFromInventory(tab, inventory)
    return <InboxRow key={`${tab.id}:settled`} tab={tab} variant="slim" projectName={inboxProjectFor(tab, benches).name} benches={benches} inventory={inventory} rightBoundaryRef={sidebarRef} unread={partition.meta.get(tab.id)?.unread ?? false} woke={partition.meta.get(tab.id)?.wokeAt != null} backgroundLiveness={partition.meta.get(tab.id)?.backgroundLiveness ?? null} canRestore={canRestore} onOpen={canRestore ? openSettledReview : undefined} />
  }
  const shelf = (label: string, count: number, expanded: boolean, toggleShelf: () => void, accent?: string): React.JSX.Element => (
    <button onClick={toggleShelf} style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', marginTop: 9, padding: '4px 8px', border: 'none', background: 'transparent', color: accent ?? colors.textTertiary, cursor: 'pointer', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em' }}>
      {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
      {expanded ? label : `${label} (${count})`}
      <span style={{ height: 1, flex: 1, background: accent ? `${accent}33` : colors.containerBorder }} />
    </button>
  )
  const selectedProjectNames = projectOptions
    .filter((project) => projectFilter.has(project.key))
    .map((project) => project.name)
  const scopeName = selectedProjectNames.length === 0
    ? 'All projects'
    : selectedProjectNames.length === 1
      ? selectedProjectNames[0]!
      : `${selectedProjectNames.length} projects`
  const sortName = sortOrder === 'activity' ? 'Recent activity' : sortOrder === 'created' ? 'Newest created' : 'Title'

  if (showHistory) return <SettledHistoryView history={historySettled} onBack={() => setShowHistory(false)} />
  return <div ref={sidebarRef} data-testid="inbox-sidebar" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.containerBorder}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><MagnifyingGlass size={12} color={colors.textTertiary} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" spellCheck={false} style={{ flex: 1, minWidth: 0, fontSize: 11, border: 'none', outline: 'none', background: 'transparent', color: colors.textPrimary }} /><button ref={composeButton} onClick={() => setComposeOpen(true)} aria-label="New conversation" style={iconButton(colors)}><NotePencil size={14} /></button></div>
      <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
        <InboxControlButton buttonRef={projectButton} active={projectFilter.size > 0} onClick={() => {
          setSortAnchor(null)
          setProjectAnchor((current) => {
            if (current) return null
            const rect = projectButton.current?.getBoundingClientRect()
            return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 }
          })
        }}><Folder size={12} /><span>{scopeName}</span></InboxControlButton>
        <InboxControlButton buttonRef={sortButton} active={sortOrder !== 'created'} onClick={() => {
          setProjectAnchor(null)
          setSortAnchor((current) => {
            if (current) return null
            const rect = sortButton.current?.getBoundingClientRect()
            return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 }
          })
        }}><SortAscending size={12} /><span>{sortName}</span></InboxControlButton>
        <span style={{ flex: 1 }} />
        <button onClick={collapseAll} aria-label="Collapse all" style={iconControlButton(colors)}><ArrowsInLineVertical size={14} /></button>
        <button onClick={expandAll} aria-label="Expand all" style={iconControlButton(colors)}><ArrowsOutLineVertical size={14} /></button>
      </div>
      {composeOpen && <NewConversationPicker onClose={() => setComposeOpen(false)} />}
      {projectAnchor && <InboxProjectScopePicker anchor={projectAnchor} projects={projectOptions} selected={projectFilter} onSelect={setProjectFilter} triggerRef={projectButton} onClose={() => setProjectAnchor(null)} />}
      {sortAnchor && <InboxSortPicker anchor={sortAnchor} selected={sortOrder} onSelect={setSortOrder} triggerRef={sortButton} onClose={() => setSortAnchor(null)} />}
    </div>
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px' }}>
      {searching ? (searchRows.length ? searchRows.map((tab) => tab.settledAt != null ? settledRow(tab) : row(tab, 'card', inboxProjectFor(tab, benches).name)) : <div style={emptyText(colors)}>No conversations found.</div>) : <>
        <InboxNavigatorGroups projects={activeNavigator} collapsed={activeCollapsed} onToggle={(key) => toggle(setActiveCollapsed, key)} variant="card" selectedBench={selectedBench} onSelectBench={(repoPath, sourceBranch) => setSelectedBench((current) => ({ ...current, [repoPath]: sourceBranch }))} row={row} />
        {activeNavigator.length === 0 && <div style={emptyText(colors)}>Inbox zero.</div>}
        {snoozedTabs.length > 0 && <>{shelf('Snoozed', snoozedTabs.length, snoozedOpen, () => setSnoozedOpen((value) => !value), colors.accent)}{snoozedOpen && <InboxNavigatorGroups projects={snoozedNavigator} collapsed={snoozedCollapsed} onToggle={(key) => toggle(setSnoozedCollapsed, key)} variant="slim" selectedBench={selectedBench} onSelectBench={(repoPath, sourceBranch) => setSelectedBench((current) => ({ ...current, [repoPath]: sourceBranch }))} row={row} />}</>}
        {recentSettled.length > 0 && <>{shelf('Settled', allSettled.length, settledOpen, () => setSettledOpen((value) => !value))}{settledOpen && settledOrder(recentSettled).slice(0, settledShown).map(settledRow)}{settledOpen && recentSettled.length > settledShown && <button onClick={() => setSettledShown((value) => value + SETTLED_PAGE)} style={moreButton(colors)}>Show {Math.min(SETTLED_PAGE, recentSettled.length - settledShown)} more</button>}{settledOpen && historySettled.length > 0 && <button onClick={() => setShowHistory(true)} style={historyButton(colors)}>View all history ({historySettled.length})</button>}</>}
      </>}
    </div>
  </div>
}
function iconButton(colors: ReturnType<typeof useColors>): React.CSSProperties { return { border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', display: 'flex' } }
function iconControlButton(colors: ReturnType<typeof useColors>): React.CSSProperties { return { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, border: `1px solid ${colors.containerBorder}`, borderRadius: 5, background: 'transparent', color: colors.textSecondary, cursor: 'pointer', padding: 0 } }
function emptyText(colors: ReturnType<typeof useColors>): React.CSSProperties { return { padding: 12, fontSize: 11, color: colors.textTertiary } }
function moreButton(colors: ReturnType<typeof useColors>): React.CSSProperties { return { border: 'none', background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10, padding: '5px 10px' } }
function historyButton(colors: ReturnType<typeof useColors>): React.CSSProperties { return { display: 'block', width: '100%', border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', fontSize: 10, padding: '6px 10px', textAlign: 'left' } }
