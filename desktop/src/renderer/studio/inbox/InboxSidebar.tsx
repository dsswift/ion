import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsInLineVertical, ArrowsOutLineVertical, Broadcast, CaretDown, CaretRight, Folder, MagnifyingGlass, NotePencil, FolderPlus, SortAscending } from '@phosphor-icons/react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useInboxPartition } from './useInboxPartition'
import { InboxRow, type InboxRowVariant } from './InboxRow'
import { useEnvironmentViewFilter } from '../connection/view-filter'
import { useDeveloperSurfacesLookup } from '../connection/developer-surfaces'
import { tabListKey, withTargetEnvironment } from '../connection/tab-environment'
import { environmentOfWorktreeRepo } from '../state/secondary-store-worktree-sync'
import { tabMatchesEnvironmentFilter } from '../connection/view-filter'
import { fuzzyMatchCommand } from '@ion/shared/fuzzy-match'
import { NewConversationPicker } from '../../components/NewConversationPicker'
import { NewProjectPanel, type ProjectCheckout } from '../new-project/NewProjectPanel'
import { InboxControlButton, InboxEnvironmentPicker, InboxProjectScopePicker, InboxSortPicker } from './InboxControls'
import { DEFAULT_INBOX_SORT_ORDER, parseInboxSortOrder, type InboxSortOrder } from './inbox-sort'
import { inboxProjectFor } from './inbox-grouping'
import { partitionSettled } from './settled-history'
import { SettledHistoryView } from './SettledHistoryView'
import { InboxNavigatorGroups } from './InboxNavigatorGroups'
import { buildInboxNavigator, inboxGroupRowKey, inboxNavigatorProjectFor, inboxProjectRowKey, type InboxNavigatorOptions, type InboxNavigatorProject } from './inbox-navigator'
import { buildProjectScopeResolver, normalizeProjectSelection } from './project-identity'
import { useProjectsByEnvironment } from '../connection/environment-projects'
import { onCatalogChange, readConversationCatalog } from '../connection/catalog'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { isInboxTabWorking, orderInboxTabs } from './inbox-collapse'
import { loadProjectSelection, saveProjectSelection, type InboxProjectSelection } from './project-selection'
import { rInfo, rWarn } from '../../rendererLogger'
import { settledRecordRestorableFromInventory } from '@ion/server/store/settled-worktree'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { orderedProjects } from '@ion/shared/project-registry'
import type { TabState } from '@ion/shared/types'
import { LOCAL_ENVIRONMENT_LABEL } from '../connection/local-label'

const SETTLED_INITIAL = 10
const SETTLED_PAGE = 25
const SNOOZED_EXPANDED_KEY = 'ion:inbox:snoozed-expanded'
const SETTLED_EXPANDED_KEY = 'ion:inbox:settled-expanded'
const ACTIVE_COLLAPSED_KEY = 'ion:inbox:active-collapsed'
const SNOOZED_COLLAPSED_KEY = 'ion:inbox:snoozed-collapsed'
const PROJECT_FILTER_KEY = 'ion:inbox:project-filter'
const SORT_ORDER_KEY = 'ion:inbox:sort-order'
const WORKING_LAST_KEY = 'ion:inbox:working-last'

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
  return parseInboxSortOrder(localStorage.getItem(SORT_ORDER_KEY))
}
function settledOrder(tabs: readonly TabState[]): TabState[] {
  return [...tabs].sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0) || left.id.localeCompare(right.id))
}

/** A row's React key: the machine, the conversation, and the row's shape (see `tabListKey`). */
function inboxRowKey(tab: TabState, variant: InboxRowVariant | 'settled'): string {
  return `${tabListKey(tab)}:${variant}`
}

export function InboxSidebar(): React.JSX.Element {
  const colors = useColors()
  const partition = useInboxPartition()
  const benches = useSessionStore((state) => state.benchWorkspaces)
  const inventory = useSessionStore((state) => state.worktreeInventory)
  const registeredProjects = usePreferencesStore((state) => state.projects)
  const settledHistory = useSessionStore((state) => state.settledHistory)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<InboxProjectSelection>(savedProjectFilter)
  const [sortOrder, setSortOrder] = useState<InboxSortOrder>(savedSortOrder)
  const [workingLast, setWorkingLast] = useState(() => savedBoolean(WORKING_LAST_KEY, false))
  const panes = useSessionStore((state) => state.conversationPanes)
  const isWorking = useMemo(() => workingLast ? (tab: TabState): boolean => isInboxTabWorking(tab, panes.get(tab.id)) : undefined, [workingLast, panes])
  const [projectAnchor, setProjectAnchor] = useState<{ x: number; y: number } | null>(null)
  const [sortAnchor, setSortAnchor] = useState<{ x: number; y: number } | null>(null)
  const [environmentAnchor, setEnvironmentAnchor] = useState<{ x: number; y: number } | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  // A project that was just created and cloned: the picker opens a conversation in it.
  const [newProjectCheckout, setNewProjectCheckout] = useState<ProjectCheckout | null>(null)
  const [snoozedOpen, setSnoozedOpen] = useState(() => savedBoolean(SNOOZED_EXPANDED_KEY, false))
  const [settledOpen, setSettledOpen] = useState(() => savedBoolean(SETTLED_EXPANDED_KEY, true))
  const [settledShown, setSettledShown] = useState(SETTLED_INITIAL)
  const [activeCollapsed, setActiveCollapsed] = useState<Set<string>>(() => savedSet(ACTIVE_COLLAPSED_KEY))
  const [snoozedCollapsed, setSnoozedCollapsed] = useState<Set<string>>(() => savedSet(SNOOZED_COLLAPSED_KEY))
  const [showHistory, setShowHistory] = useState(false)
  const [selectedBench, setSelectedBench] = useState<Record<string, string>>({})
  // `All | Local | <environment>` (spec 13): a per-device filter over the
  // union, never a reconnect -- every Environment stays connected and
  // live behind it.
  const [environmentFilter, setEnvironmentFilter] = useEnvironmentViewFilter()
  const composeButton = useRef<HTMLButtonElement>(null)
  const projectButton = useRef<HTMLButtonElement>(null)
  const environmentButton = useRef<HTMLButtonElement>(null)
  const sortButton = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Memoized because these arrays are the memo inputs for every navigator below
  // AND the input to the workspace-refresh effect. Rebuilding them inline gave
  // them a new identity on every render, so `allProjects` never hit its memo and
  // the effect fired every render — and since the refresh writes the store this
  // component subscribes to, that was a self-sustaining render loop.
  // The project scope is a set of repository identities: the same
  // repository on two environments is one project (project-identity.ts).
  const [environmentCatalog, setEnvironmentCatalog] = useState<EnvironmentCatalogEntry[]>([])
  useEffect(() => {
    const load = (): void => {
      void readConversationCatalog().then(setEnvironmentCatalog).catch((error: unknown) => rWarn('inbox', 'environment catalog read failed', { error: String(error) }))
    }
    load()
    return onCatalogChange(load)
  }, [])
  const projectsByEnvironment = useProjectsByEnvironment(environmentCatalog)
  const scopeOf = useMemo(() => buildProjectScopeResolver(projectsByEnvironment), [projectsByEnvironment])
  const surfacesOf = useDeveloperSurfacesLookup()
  const navigatorOptions = useMemo<InboxNavigatorOptions>(() => ({
    scopeOf,
    environmentLabel: (id) => environmentCatalog.find((entry) => entry.id === id)?.label ?? id,
    environmentOfRepo: environmentOfWorktreeRepo,
    worktreesOffered: (id) => surfacesOf(id).worktrees,
  }), [scopeOf, environmentCatalog, surfacesOf])
  // The inbox sections honor the Environment filter; the project picker
  // below still lists every machine's projects.
  const filteredNavigatorOptions = useMemo<InboxNavigatorOptions>(() => ({
    ...navigatorOptions,
    environmentIncluded: (environmentId) => tabMatchesEnvironmentFilter({ environmentId }, environmentFilter),
  }), [navigatorOptions, environmentFilter])
  useEffect(() => {
    setProjectFilter((current) => {
      const next = normalizeProjectSelection(current, projectsByEnvironment)
      if (next !== current) rInfo('inbox', 'project scope normalized to repository identities', { before: [...current], after: [...next] })
      return next
    })
  }, [projectsByEnvironment])
  const visible = useCallback((tabs: readonly TabState[]): TabState[] => tabs.filter((tab) => {
    if (!tabMatchesEnvironmentFilter(tab, environmentFilter)) return false
    const project = inboxNavigatorProjectFor(tab, benches, inventory)
    const scopeKey = scopeOf(project.key, tab.environmentId ?? LOCAL_ENVIRONMENT_ID)
    if (projectFilter.size > 0 && !projectFilter.has(scopeKey) && !projectFilter.has(project.key)) return false
    if (!query.trim()) return true
    return fuzzyMatchCommand(query, tab.customTitle || tab.title) !== null || fuzzyMatchCommand(query, project.name) !== null
  }), [projectFilter, query, benches, inventory, environmentFilter, scopeOf])
  const activeTabs = useMemo(() => visible([...partition.pinned, ...partition.inbox]), [visible, partition.pinned, partition.inbox])
  const snoozedTabs = useMemo(() => visible(partition.snoozed), [visible, partition.snoozed])
  const allSettled = useMemo(() => visible([...partition.settled, ...settledHistory]), [visible, partition.settled, settledHistory])
  const { recent: recentSettled, history: historySettled } = useMemo(() => partitionSettled(settledOrder(allSettled), Date.now()), [allSettled])
  const activeNavigator = useMemo(() => buildInboxNavigator(orderInboxTabs(activeTabs, sortOrder, isWorking), benches, inventory, new Map(Object.entries(selectedBench)), projectFilter, filteredNavigatorOptions), [activeTabs, benches, inventory, sortOrder, isWorking, selectedBench, projectFilter, filteredNavigatorOptions])
  const snoozedNavigator = useMemo(() => buildInboxNavigator(orderInboxTabs(snoozedTabs, sortOrder), benches, inventory, new Map(Object.entries(selectedBench)), projectFilter, filteredNavigatorOptions), [snoozedTabs, benches, inventory, sortOrder, selectedBench, projectFilter, filteredNavigatorOptions])
  const allProjects = useMemo(() => buildInboxNavigator([...partition.pinned, ...partition.inbox, ...partition.snoozed], benches, inventory, new Map(Object.entries(selectedBench)), new Set(), navigatorOptions), [partition.pinned, partition.inbox, partition.snoozed, benches, inventory, selectedBench, navigatorOptions])
  const projectOptions = useMemo(() => {
    const live = new Map(allProjects.map((node) => [node.scopeKey, { key: node.scopeKey, name: node.project.name, count: node.flatTabs.length + node.groups.reduce((sum, group) => sum + group.tabs.length, 0) }]))
    for (const project of orderedProjects(registeredProjects ?? {})) {
      const scopeKey = scopeOf(project.dir, LOCAL_ENVIRONMENT_ID)
      const existing = live.get(scopeKey)
      live.set(scopeKey, { key: scopeKey, name: project.displayName, count: existing?.count ?? 0 })
    }
    return [...live.values()].sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key))
  }, [allProjects, registeredProjects, scopeOf])
  const searching = query.trim().length > 0
  const searchRows = searching ? orderInboxTabs([...activeTabs, ...snoozedTabs, ...recentSettled], sortOrder) : []

  useEffect(() => { localStorage.setItem(ACTIVE_COLLAPSED_KEY, JSON.stringify([...activeCollapsed])) }, [activeCollapsed])
  useEffect(() => { localStorage.setItem(SNOOZED_COLLAPSED_KEY, JSON.stringify([...snoozedCollapsed])) }, [snoozedCollapsed])
  useEffect(() => { localStorage.setItem(SNOOZED_EXPANDED_KEY, String(snoozedOpen)) }, [snoozedOpen])
  useEffect(() => { localStorage.setItem(SETTLED_EXPANDED_KEY, String(settledOpen)) }, [settledOpen])
  // Saved only when the operator picks one, so an install that never chose
  // keeps following the default instead of freezing it into storage.
  const chooseSortOrder = useCallback((order: InboxSortOrder) => {
    localStorage.setItem(SORT_ORDER_KEY, order)
    rInfo('inbox', 'sort order chosen', { sort_order: order })
    setSortOrder(order)
  }, [])
  useEffect(() => { localStorage.setItem(WORKING_LAST_KEY, String(workingLast)) }, [workingLast])
  useEffect(() => {
    const stored = saveProjectSelection(projectFilter)
    if (stored) localStorage.setItem(PROJECT_FILTER_KEY, stored)
    else localStorage.removeItem(PROJECT_FILTER_KEY)
    rInfo('inbox', 'project scope applied', {
      project_scope: projectFilter.size === 0 ? 'all' : [...projectFilter],
    })
  }, [projectFilter])
  // Keyed on the checkout TOKEN, never on `allProjects` identity. Memoizing
  // the navigator inputs above is what makes the memo hit, but a dep on an
  // object identity is one accidental un-memoized input away from firing every
  // render again — and this effect writes the store the component reads, so
  // that misfire is a CPU-pinning loop rather than a wasted render. The token
  // only changes when the set of checkouts actually changes.
  // JSON-encoded rather than delimiter-joined: a project key is a repo path,
  // and there is no separator character a path cannot legally contain.
  // Each checkout is re-read on its own Environment: a refresh names no tab,
  // so without the target it would run on the local server against a path
  // that may only exist on another machine.
  const checkoutToken = JSON.stringify(allProjects.flatMap((node) => node.checkouts))
  useEffect(() => {
    const refresh = useSessionStore.getState().refreshWorkspaceViews
    for (const { environmentId, key } of JSON.parse(checkoutToken) as InboxNavigatorProject['checkouts']) {
      void withTargetEnvironment(environmentId, () => refresh(key))
    }
  }, [checkoutToken])

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string): void => set((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  // Read from the page, so the log shows what is drawn rather than what the navigator asked for.
  const worktreeHeaderCount = (): number => sidebarRef.current?.querySelectorAll('[data-testid^="inbox-worktree-header-"]').length ?? 0
  const collapseAll = (): void => {
    const keysFor = (variant: InboxRowVariant): Set<string> => new Set(allProjects.flatMap((node) => [inboxProjectRowKey(node), ...node.groups.map((group) => inboxGroupRowKey(node, group, variant))]))
    const active = keysFor('card')
    rInfo('inbox', 'collapse all', { key_count: active.size, project_count: allProjects.length, environment_filter: environmentFilter, worktree_header_count: worktreeHeaderCount() })
    setActiveCollapsed(active)
    setSnoozedCollapsed(keysFor('slim'))
  }
  const expandAll = (): void => {
    rInfo('inbox', 'expand all', { project_count: allProjects.length, environment_filter: environmentFilter, worktree_header_count: worktreeHeaderCount() })
    setActiveCollapsed(new Set()); setSnoozedCollapsed(new Set())
  }
  const row = (tab: TabState, variant: InboxRowVariant, projectName: string): React.JSX.Element => <InboxRow key={inboxRowKey(tab, variant)} tab={tab} variant={variant} projectName={projectName} benches={benches} inventory={inventory} rightBoundaryRef={sidebarRef} unread={partition.meta.get(tab.id)?.unread ?? false} woke={partition.meta.get(tab.id)?.wokeAt != null} backgroundLiveness={partition.meta.get(tab.id)?.backgroundLiveness ?? null} />
  const openSettledReview = (tab: TabState): void => {
    const state = useSessionStore.getState()
    if (state.settledHistory.some((record) => record.id === tab.id)) void state.restoreSettledHistoryTab(tab.id)
    else state.selectTab(tab.id)
  }
  const settledRow = (tab: TabState): React.JSX.Element => {
    const canRestore = settledRecordRestorableFromInventory(tab, inventory)
    return <InboxRow key={inboxRowKey(tab, 'settled')} tab={tab} variant="slim" projectName={inboxProjectFor(tab, benches).name} benches={benches} inventory={inventory} rightBoundaryRef={sidebarRef} unread={partition.meta.get(tab.id)?.unread ?? false} woke={partition.meta.get(tab.id)?.wokeAt != null} backgroundLiveness={partition.meta.get(tab.id)?.backgroundLiveness ?? null} canRestore={canRestore} onOpen={canRestore ? openSettledReview : undefined} />
  }
  const shelf = (label: string, count: number, expanded: boolean, toggleShelf: () => void, accent?: string): React.JSX.Element => (
    <button onClick={toggleShelf} style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', marginTop: 9, padding: '4px 8px', border: 'none', background: 'transparent', color: accent ?? colors.textTertiary, cursor: 'pointer', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em' }}>
      {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
      {expanded ? label : `${label} (${count})`}
      <span style={{ height: 1, flex: 1, background: accent ? `${accent}33` : colors.containerBorder }} />
    </button>
  )
  // Counted before the environment filter is applied, so each row says how
  // many conversations picking it would show rather than how many the
  // current filter already left visible.
  const environmentOptions = [...environmentCatalog]
    .sort((a, b) => (a.id === LOCAL_ENVIRONMENT_ID ? -1 : b.id === LOCAL_ENVIRONMENT_ID ? 1 : a.label.localeCompare(b.label)))
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      count: [...partition.pinned, ...partition.inbox, ...partition.snoozed].filter((tab) => (tab.environmentId ?? LOCAL_ENVIRONMENT_ID) === entry.id).length,
    }))
  const environmentName = environmentFilter === 'all'
    ? 'All environments'
    : environmentFilter === 'local'
      ? (environmentOptions.find((entry) => entry.id === LOCAL_ENVIRONMENT_ID)?.label ?? LOCAL_ENVIRONMENT_LABEL)
      : (environmentOptions.find((entry) => entry.id === environmentFilter)?.label ?? environmentFilter)

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><MagnifyingGlass size={12} color={colors.textTertiary} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" spellCheck={false} style={{ flex: 1, minWidth: 0, fontSize: 11, border: 'none', outline: 'none', background: 'transparent', color: colors.textPrimary }} /><button onClick={() => setNewProjectOpen(true)} aria-label="New project" title="New project" style={iconButton(colors)}><FolderPlus size={14} /></button><button ref={composeButton} onClick={() => setComposeOpen(true)} aria-label="New conversation" style={iconButton(colors)}><NotePencil size={14} /></button></div>
      <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
        <InboxControlButton
          buttonRef={projectButton}
          active={projectFilter.size > 0}
          icon={<Folder size={13} />}
          title={`Project scope: ${scopeName}`}
          label={projectFilter.size > 0 ? scopeName : null}
          onClick={() => {
            setEnvironmentAnchor(null)
            setSortAnchor(null)
            setProjectAnchor((current) => {
              if (current) return null
              const rect = projectButton.current?.getBoundingClientRect()
              return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 }
            })
          }}
        />
        <InboxControlButton
          buttonRef={environmentButton}
          active={environmentFilter !== 'all'}
          icon={<Broadcast size={13} />}
          title={`Environments: ${environmentName}`}
          label={environmentFilter !== 'all' ? environmentName : null}
          onClick={() => {
            setProjectAnchor(null)
            setSortAnchor(null)
            setEnvironmentAnchor((current) => {
              if (current) return null
              const rect = environmentButton.current?.getBoundingClientRect()
              return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 }
            })
          }}
        />
        <InboxControlButton
          buttonRef={sortButton}
          active={sortOrder !== DEFAULT_INBOX_SORT_ORDER}
          icon={<SortAscending size={13} />}
          title={`Sort: ${sortName}`}
          label={sortOrder !== DEFAULT_INBOX_SORT_ORDER ? sortName : null}
          onClick={() => {
            setEnvironmentAnchor(null)
            setProjectAnchor(null)
            setSortAnchor((current) => {
              if (current) return null
              const rect = sortButton.current?.getBoundingClientRect()
              return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 }
            })
          }}
        />
        <span style={{ flex: 1 }} />
        <button onClick={collapseAll} aria-label="Collapse all" style={iconControlButton(colors)}><ArrowsInLineVertical size={14} /></button>
        <button onClick={expandAll} aria-label="Expand all" style={iconControlButton(colors)}><ArrowsOutLineVertical size={14} /></button>
      </div>
      {composeOpen && <NewConversationPicker onClose={() => setComposeOpen(false)} />}
      {newProjectOpen && <NewProjectPanel onClose={() => setNewProjectOpen(false)} onOpenProject={(checkout) => { setNewProjectOpen(false); setNewProjectCheckout(checkout) }} />}
      {newProjectCheckout && <NewConversationPicker initialDirectory={newProjectCheckout.directory} initialEnvironmentId={newProjectCheckout.environmentId} onClose={() => setNewProjectCheckout(null)} />}
      {projectAnchor && <InboxProjectScopePicker anchor={projectAnchor} projects={projectOptions} selected={projectFilter} onSelect={setProjectFilter} triggerRef={projectButton} onClose={() => setProjectAnchor(null)} />}
      {environmentAnchor && <InboxEnvironmentPicker anchor={environmentAnchor} environments={environmentOptions} selected={environmentFilter} onSelect={(next) => { rInfo('inbox', 'environment view filter changed', { filter: next }); setEnvironmentFilter(next) }} triggerRef={environmentButton} onClose={() => setEnvironmentAnchor(null)} />}
      {sortAnchor && <InboxSortPicker anchor={sortAnchor} selected={sortOrder} onSelect={chooseSortOrder} workingLast={workingLast} onWorkingLast={setWorkingLast} triggerRef={sortButton} onClose={() => setSortAnchor(null)} />}
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
