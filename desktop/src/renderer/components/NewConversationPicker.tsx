import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, MagnifyingGlass } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import type { PreferencesState } from '@ion/server/preferences-types'
import { isEngineProfileList, useServerSetting } from '../studio/state/use-server-setting'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { defaultProject, effectiveProjects, type ManagedProject } from '@ion/shared/project-registry'
import { rError, rInfo, rWarn } from '../rendererLogger'
import { filterProjects } from './new-conversation-project-search'
import { useProjectsByEnvironment, buildMergedProjects, defaultRowEnvironment, rowEnvironments, type MergedProjectRow } from '../studio/connection/environment-projects'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { filterBranches } from './new-conversation-workspaces'
import { BranchRows, ProfileRows, ProjectRows } from './NewConversationPickerRows'
import { ProjectListControls } from './NewConversationPickerControls'
import { flattenProjectGroups, groupProjectRows, isProjectGrouping, isProjectSortOrder, type ProjectGrouping, type ProjectSortOrder } from './new-conversation-project-order'
import { resolveConversationProfileAction } from './new-conversation-routing'
import type { EngineProfile } from '@ion/shared/types'
import type { NewConversationPickerTarget } from './new-conversation-picker-target'
import { host } from '../host/host-instance'
import { refusalForDraftEnvironment } from '../studio/connection/draft-lock'
import { policyStore } from '../studio/connection/policy-store'
import { deriveDesktopEnvironmentPolicy } from '@ion/shared/enterprise-environment-policy'
import { readCatalog } from '../studio/connection/catalog'
import { withTargetEnvironment } from '../studio/connection/tab-environment'
import { selectTabWhenPresent } from '../studio/connection/select-when-present'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { LOCAL_ENVIRONMENT_LABEL } from '../studio/connection/local-label'

const NO_PROFILES: PreferencesState['engineProfiles'] = []

type PickerView = 'projects' | 'branches' | 'profiles'

// How the project list is ordered and divided is a per-device view
// preference, like the Inbox's own sort: it says nothing about the work, so
// it stays on the machine the operator set it on and never syncs.
const SORT_KEY = 'ion.new-conversation-picker.sort'
const GROUPING_KEY = 'ion.new-conversation-picker.grouping'
const COLLAPSED_KEY = 'ion.new-conversation-picker.collapsed-groups'

function savedSortOrder(): ProjectSortOrder {
  const value = localStorage.getItem(SORT_KEY)
  return isProjectSortOrder(value) ? value : 'most-used'
}
function savedGrouping(): ProjectGrouping {
  const value = localStorage.getItem(GROUPING_KEY)
  return isProjectGrouping(value) ? value : 'local-first'
}
function savedCollapsedGroups(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch (error) {
    rWarn('new-conversation-picker', 'collapsed group state unreadable, starting expanded', { error: String(error) })
    return new Set()
  }
}
/** `environmentId` is the machine `directory` is a path on; every call about this workspace goes there. */
type WorkspaceChoice = { directory: string; projectDirectory: string; environmentId: string; useWorktree?: boolean; sourceBranch?: string }

interface NewConversationPickerProps extends NewConversationPickerTarget {
  onClose(): void
}

/** Selects a controlled Project and conversation type. Worktree creation is explicit. */
export function NewConversationPicker({ initialDirectory, initialEnvironmentId = LOCAL_ENVIRONMENT_ID, initialUseWorktree = false, initialSourceBranch, forceProfilePicker = false, onClose }: NewConversationPickerProps): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const inputRef = useRef<HTMLInputElement>(null)
  const autoCreateStarted = useRef(false)
  const registry = usePreferencesStore((state) => state.projects)
  // Real recorded use, not an estimate: every machine bumps this when work
  // starts in a directory. A remote machine's counts ride in on its own
  // project listing instead.
  const localUsage = usePreferencesStore((state) => state.directoryUsageCounts)
  const enterprisePolicy = usePreferencesStore((state) => state.enterpriseNewConversationDefaults)
  const fullEnterprisePolicy = usePreferencesStore((state) => state.enterprisePolicy)
  const managedProjects = useMemo<ManagedProject[]>(() => (fullEnterprisePolicy?.newConversationDefaults?.projects ?? []).map((project) => ({ directory: project.directory, name: project.name, isDefault: project.default, profileAction: project.profileName ? 'profile' : 'ask', profileSource: project.profileName ? 'enterprise-project' : undefined })), [fullEnterprisePolicy])
  const effectiveProjectList = useMemo(() => effectiveProjects(registry, managedProjects), [managedProjects, registry])
  const [view, setView] = useState<PickerView>(() => {
    if (initialDirectory) return initialUseWorktree && !initialSourceBranch ? 'branches' : 'profiles'
    return defaultProject(registry, managedProjects) ? 'profiles' : 'projects'
  })
  const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(() => {
    if (initialDirectory) return { directory: initialDirectory, projectDirectory: initialDirectory, environmentId: initialEnvironmentId, useWorktree: initialUseWorktree, sourceBranch: initialSourceBranch }
    // The starred Project comes from this machine's own registry.
    const project = defaultProject(registry, managedProjects)
    return project ? { directory: project.dir, projectDirectory: project.dir, environmentId: LOCAL_ENVIRONMENT_ID } : null
  })
  // Conversation profiles belong to the server the conversation opens on. This
  // machine's list names profiles another server does not have.
  const profiles = useServerSetting(workspace?.environmentId ?? LOCAL_ENVIRONMENT_ID, 'engineProfiles', isEngineProfileList, NO_PROFILES)
  const [query, setQuery] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const [environmentCatalog, setEnvironmentCatalog] = useState<EnvironmentCatalogEntry[]>([])
  useEffect(() => {
    void readCatalog().then(setEnvironmentCatalog).catch((error: unknown) =>
      rError('new-conversation-picker', 'environment catalog read failed', { error: String(error) }))
  }, [])

  // The project list is one row per repository across every environment
  // (ADR-033 union store). Where a conversation opens is decided by the one
  // click that opens it: a click on the row opens it on this machine when
  // this machine has the repository, else on the first machine that does; the
  // trailing control offers the other machines, and picking one opens it
  // there. Neither is remembered, and neither follows the active tab, so
  // working in a conversation on another machine never moves where the next
  // one starts. A device restricted to central environments is not offered
  // its own checkouts at all.
  const multi = environmentCatalog.length > 1
  const byEnvironment = useProjectsByEnvironment(multi ? environmentCatalog : [])
  const localAllowed = useMemo(() => refusalForDraftEnvironment(LOCAL_ENVIRONMENT_ID, deriveDesktopEnvironmentPolicy(policyStore.devicePolicy())) === null, [])
  const pickerCatalog = useMemo(() => multi ? environmentCatalog.map((e) => ({ id: e.id, label: e.label })) : [{ id: LOCAL_ENVIRONMENT_ID, label: LOCAL_ENVIRONMENT_LABEL }], [multi, environmentCatalog])
  const pickerProjects = useMemo<MergedProjectRow[]>(() => {
    const rows = buildMergedProjects({ local: effectiveProjectList, byEnvironment, catalog: pickerCatalog, localUsage })
    if (localAllowed) return rows
    return rows
      .map((row) => ({ ...row, holders: row.holders.filter((h) => h.environmentId !== LOCAL_ENVIRONMENT_ID) }))
      .filter((row) => row.holders.length > 0)
  }, [effectiveProjectList, pickerCatalog, byEnvironment, localAllowed, localUsage])

  const [sortOrder, setSortOrder] = useState<ProjectSortOrder>(savedSortOrder)
  const [grouping, setGrouping] = useState<ProjectGrouping>(savedGrouping)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(savedCollapsedGroups)
  // Every grouping draws the same single list when there is only one machine,
  // so the control is hidden there and the list stays flat.
  const effectiveGrouping: ProjectGrouping = multi ? grouping : 'none'
  const projectMatches = useMemo(() => filterProjects(pickerProjects, query), [pickerProjects, query])
  const projectGroups = useMemo(() => groupProjectRows({ rows: projectMatches, grouping: effectiveGrouping, order: sortOrder, catalog: pickerCatalog }), [projectMatches, effectiveGrouping, sortOrder, pickerCatalog])
  // One walk decides both what is drawn and what the keyboard visits, so a
  // collapsed section cannot leave the highlight on a row nobody can see.
  const flatRows = useMemo(() => flattenProjectGroups(projectGroups, collapsedGroups), [projectGroups, collapsedGroups])
  const rowIndex = useMemo(() => new Map(flatRows.map((entry, index) => [`${entry.groupKey}:${entry.row.key}`, index])), [flatRows])
  const indexOfRow = useCallback((groupKey: string, rowKey: string): number => rowIndex.get(`${groupKey}:${rowKey}`) ?? -1, [rowIndex])
  const chooseSortOrder = (order: ProjectSortOrder): void => {
    setSortOrder(order); localStorage.setItem(SORT_KEY, order)
    rInfo('new-conversation-picker', 'project sort changed', { sort_order: order })
  }
  const chooseGrouping = (next: ProjectGrouping): void => {
    setGrouping(next); localStorage.setItem(GROUPING_KEY, next)
    rInfo('new-conversation-picker', 'project grouping changed', { grouping: next })
  }
  const toggleGroup = (groupKey: string): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      rInfo('new-conversation-picker', 'project group toggled', { group_key: groupKey, collapsed: next.has(groupKey) })
      return next
    })
  }

  // Keyboard only: which machine Enter opens the highlighted row on. It names
  // its row, so moving the highlight returns every row to its default. A
  // per-machine section already fixes the machine, so the cursor does not
  // apply there.
  const [chipCursor, setChipCursor] = useState<{ rowKey: string; environmentId: string } | null>(null)
  const actingEnvironmentFor = useCallback((row: MergedProjectRow, groupEnvironmentId: string | null): string => {
    if (groupEnvironmentId && rowEnvironments(row).includes(groupEnvironmentId)) return groupEnvironmentId
    if (chipCursor?.rowKey === row.key && rowEnvironments(row).includes(chipCursor.environmentId)) return chipCursor.environmentId
    return defaultRowEnvironment(row)
  }, [chipCursor])
  const branchMatches = useMemo(() => filterBranches(branches, query), [branches, query])
  const profileMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return profiles.filter((profile) => !needle || profile.name.toLocaleLowerCase().includes(needle))
  }, [profiles, query])
  const [recommendation, setRecommendation] = useState<{ profileId?: string; profileName?: string; profileLocked?: boolean; source?: string; status?: 'resolved' | 'missing' | 'ambiguous' } | undefined>()
  // The registry is this machine's; a path on another machine is a different project even when the strings match.
  const selectedProject = workspace && workspace.environmentId === LOCAL_ENVIRONMENT_ID ? registry[workspace.projectDirectory] : undefined
  const fallbackOverride = selectedProject?.profileOverride
  // The default profile is an Account preference of this machine's server, so it names a profile only there.
  const localDefaultProfileId = usePreferencesStore((state) => state.defaultEngineProfileId)
  const defaultProfileId = workspace && workspace.environmentId !== LOCAL_ENVIRONMENT_ID ? '' : localDefaultProfileId
  const resolvedAction = useMemo(() => resolveConversationProfileAction(profiles, forceProfilePicker ? { kind: 'ask' } : fallbackOverride, recommendation, enterprisePolicy, defaultProfileId), [defaultProfileId, enterprisePolicy, fallbackOverride, forceProfilePicker, profiles, recommendation])

  useEffect(() => {
    rInfo('new-conversation-picker', 'opened', { initial_view: view, explicit_worktree: initialUseWorktree, has_default_project: !!defaultProject(registry, managedProjects) })
    inputRef.current?.focus()
  }, [initialUseWorktree, managedProjects, registry, view])

  // Separate from the "opened" log above so this can react to
  // resolvedAction settling without re-stealing input focus. Full resolution
  // inputs, not just the outcome: the "why did this fall through to the
  // picker instead of auto-resolving" question has no other way to be
  // answered after the fact once the dialog has already rendered.
  useEffect(() => {
    rInfo('new-conversation-picker', 'profile resolution', {
      resolved_action_kind: resolvedAction.kind,
      resolved_action_source: resolvedAction.source,
      workspace_dir: workspace?.projectDirectory ?? null,
      selected_project_present: !!selectedProject,
      fallback_override: fallbackOverride ?? null,
      known_profile_ids: profiles.map((p) => p.id),
    })
  }, [resolvedAction, workspace, selectedProject, fallbackOverride, profiles])

  useEffect(() => { setHighlighted(0) }, [view, query, sortOrder, effectiveGrouping])

  useEffect(() => {
    if (!workspace) { setRecommendation(undefined); return }
    let active = true
    void withTargetEnvironment(workspace.environmentId, () => host.shell.resolveNewConversationDefaults(workspace.projectDirectory)).then((result) => {
      if (!active) return
      if (!result) { setRecommendation(undefined); return }
      setRecommendation({ profileId: result.profileId, profileName: result.profileName, profileLocked: result.profileLocked, source: result.profileLocked ? 'enterprise-project-lock' : result.profileName ? 'project-recommendation' : undefined, status: result.profileName && !result.profileId ? 'missing' : 'resolved' })
    }).catch((error: unknown) => {
      if (!active) return
      setRecommendation(undefined)
      rError('new-conversation-picker', 'project default resolution failed', { project_path: workspace.projectDirectory, environment_id: workspace.environmentId, error: String(error) })
    })
    return () => { active = false }
  }, [workspace])

  useEffect(() => {
    if (view !== 'branches' || !workspace) return
    setBranchLoading(true); setBranchError(null)
    void withTargetEnvironment(workspace.environmentId, () => host.shell.gitFetch(workspace.projectDirectory)).catch((error: unknown) => rError('new-conversation-picker', 'branch fetch failed', { project_path: workspace.projectDirectory, error: String(error) }))
    void withTargetEnvironment(workspace.environmentId, () => host.shell.gitBranches(workspace.projectDirectory)).then((result) => {
      setBranches(result.branches.filter((branch) => !branch.isRemote).map((branch) => branch.name))
      setCurrentBranch(result.current)
      rInfo('new-conversation-picker', 'branches loaded', { project_path: workspace.projectDirectory, count: result.branches.length })
    }).catch((error: unknown) => {
      setBranches([]); setBranchError(String(error))
      rError('new-conversation-picker', 'branch load failed', { project_path: workspace.projectDirectory, error: String(error) })
    }).finally(() => setBranchLoading(false))
  }, [view, workspace])

  const [environmentError, setEnvironmentError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const createInFlight = useRef(false)

  const createConversation = useCallback((choice: WorkspaceChoice, profile?: EngineProfile): void => {
    const policy = deriveDesktopEnvironmentPolicy(policyStore.devicePolicy())
    if (createInFlight.current) { rInfo('new-conversation-picker', 'conversation creation ignored: one is already in flight', { environment_id: choice.environmentId }); return }
    const targetEnvironmentId = choice.environmentId
    const refusal = refusalForDraftEnvironment(targetEnvironmentId, policy)
    if (refusal) {
      setEnvironmentError(refusal)
      rInfo('new-conversation-picker', 'conversation creation refused by environment policy', { environment_id: targetEnvironmentId, reason: refusal })
      return
    }
    const locked = enterprisePolicy?.locked === true
    const directory = locked && enterprisePolicy.baseDirectory ? enterprisePolicy.baseDirectory : choice.directory
    const profileId = locked ? enterprisePolicy.engineProfileId : profile?.id ?? (resolvedAction.kind === 'profile' ? resolvedAction.profileId : '')
    const workspaceChanged = directory !== choice.directory
    const opts = {
      ...(profileId ? { profileId } : {}),
      ...(!workspaceChanged && { useWorktree: choice.useWorktree, sourceBranch: choice.sourceBranch }),
      projectDirectory: choice.projectDirectory,
    }
    rInfo('new-conversation-picker', 'conversation creation resolved', { directory, project_directory: choice.projectDirectory, profile_id: profileId, source: locked ? 'enterprise-lock' : profile ? 'explicit-profile' : resolvedAction.source, use_worktree: !!opts.useWorktree, environment_id: targetEnvironmentId })
    // `createConversationTab` is a forwarded action with no tab to route by,
    // so the workspace's Environment is named explicitly: the action is sent
    // to the server that has the directory, the new tab arrives on its
    // tabs-sync tagged with that Environment, and it sits in this same Inbox
    // beside everything else (ADR-033 union store). Nothing in the window
    // switches.
    void withTargetEnvironment(targetEnvironmentId, () => useSessionStore.getState().createConversationTab(directory, opts)).then((created) => {
      rInfo('new-conversation-picker', 'conversation created', { directory, project_directory: choice.projectDirectory, profile_id: profileId, environment_id: targetEnvironmentId, tab_id: typeof created === 'string' ? created : '' })
      // The local server selects a tab it creates; a remote one cannot
      // reach this window's active tab, and its tab arrives on a later
      // sync. Select it here once it is in the union store.
      onClose()
      if (typeof created === 'string' && created) return selectTabWhenPresent(created)
      return undefined
    }, (error: unknown) => {
      // The server refused or could not be reached. The picker stays open
      // and says so: closing first would leave a click that did nothing.
      rError('new-conversation-picker', 'conversation create failed', { directory, environment_id: targetEnvironmentId, error: String(error) })
      createInFlight.current = false
      setCreating(false)
      setEnvironmentError(error instanceof Error ? error.message : String(error))
    }).catch((error: unknown) => rError('new-conversation-picker', 'selecting the created conversation failed', { environment_id: targetEnvironmentId, error: String(error) }))
    createInFlight.current = true
    setEnvironmentError(null)
    setCreating(true)
  }, [enterprisePolicy, onClose, resolvedAction])

  useEffect(() => {
    if (view !== 'profiles' || !workspace || autoCreateStarted.current || resolvedAction.kind === 'picker') return
    autoCreateStarted.current = true
    createConversation(workspace)
  }, [createConversation, resolvedAction, view, workspace])

  // Opens a row on one machine. `environmentId` is always one of the row's
  // holders: the row's default for a click on the row, the chip's machine for
  // a click on a chip. Nothing is stored, so the next picker starts clean.
  const chooseProject = (row: MergedProjectRow, environmentId: string = actingEnvironmentFor(row, null)): void => {
    const holder = row.holders.find((h) => h.environmentId === environmentId)
    if (!holder) { rError('new-conversation-picker', 'row has no checkout on the requested machine', { environment_id: environmentId, repo_remote: row.repoRemote ?? '' }); return }
    setEnvironmentError(null)
    setWorkspace({ directory: holder.entry.dir, projectDirectory: holder.entry.dir, environmentId }); setQuery('')
    if (initialUseWorktree) setView('branches')
    else setView('profiles')
    rInfo('new-conversation-picker', 'project selected', { directory: holder.entry.dir, environment_id: environmentId, default_environment_id: defaultRowEnvironment(row), usage_count: holder.usageCount, sort_order: sortOrder, grouping: effectiveGrouping, explicit_worktree: initialUseWorktree })
  }
  // Left and right move the highlighted row through its machines; the detail
  // line follows, so the row always says where Enter would open it. In a
  // per-machine section the section already fixes the machine.
  const cycleRowEnvironment = (direction: 1 | -1): void => {
    const entry = flatRows[highlighted]
    if (!entry || entry.environmentId) return
    const options = rowEnvironments(entry.row)
    if (options.length < 2) return
    const index = options.indexOf(actingEnvironmentFor(entry.row, null))
    setChipCursor({ rowKey: entry.row.key, environmentId: options[(index + direction + options.length) % options.length] })
  }

  const handleBack = (): void => {
    if (view === 'profiles') {
      if (initialDirectory || defaultProject(registry, managedProjects)) { onClose(); return }
      setWorkspace(null); setView('projects'); setQuery(''); return
    }
    if (view === 'branches') {
      if (initialDirectory) { onClose(); return }
      setWorkspace(null); setView('projects'); setQuery(''); return
    }
    onClose()
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); handleBack() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const count = view === 'projects' ? flatRows.length : view === 'branches' ? branchMatches.length : profileMatches.length + 1
  const selectHighlighted = (): void => {
    if (view === 'projects') { const entry = flatRows[highlighted]; if (entry) chooseProject(entry.row, actingEnvironmentFor(entry.row, entry.environmentId)); return }
    if (view === 'branches') { const branch = branchMatches[highlighted]; if (branch && workspace) { setWorkspace({ ...workspace, useWorktree: true, sourceBranch: branch }); setQuery(''); setView('profiles') }; return }
    if (!workspace) return
    if (highlighted === 0) createConversation(workspace)
    else { const profile = profileMatches[highlighted - 1]; if (profile) createConversation(workspace, profile) }
  }
  const handleInputKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted((value) => Math.min(value + 1, Math.max(0, count - 1))) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((value) => Math.max(value - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); selectHighlighted() }
    else if (view === 'projects' && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) { event.preventDefault(); cycleRowEnvironment(event.key === 'ArrowRight' ? 1 : -1) }
    else if (event.key === 'Backspace' && query === '') { event.preventDefault(); handleBack() }
  }

  // A Project with a resolved conversation type creates without showing the
  // dialog; it appears only if that creation fails, to say why.
  if (!layer || (view === 'profiles' && resolvedAction.kind !== 'picker' && !environmentError)) return null
  const placeholder = view === 'projects' ? 'Search projects…' : view === 'branches' ? 'Search branches…' : 'Search conversation profiles…'
  return createPortal(<motion.div data-ion-ui role="dialog" aria-modal="true" aria-label="New conversation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 'max(16px, 10vh) 16px 16px', boxSizing: 'border-box', background: colors.scrim }}>
    <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.99 }} transition={{ duration: 0.14 }} onMouseDown={(event) => event.stopPropagation()} style={{ width: 560, maxWidth: '100%', maxHeight: '100%', minWidth: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`, borderRadius: 12, boxShadow: colors.popoverShadow }}>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${colors.popoverBorder}`, padding: '8px 10px', gap: 8 }}><button aria-label="Back" className="ion-focusable" onClick={handleBack} style={{ display: 'flex', alignItems: 'center', padding: 4, border: 'none', borderRadius: 5, background: 'transparent', color: colors.textSecondary, cursor: 'pointer' }}><ArrowLeft size={16} /></button><MagnifyingGlass size={16} color={colors.textTertiary} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleInputKey} placeholder={placeholder} spellCheck={false} aria-label="New conversation search" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: colors.textPrimary, fontSize: 14 }} /></div>
      {view === 'projects' && <ProjectListControls sort={sortOrder} grouping={grouping} showGrouping={multi} onSort={chooseSortOrder} onGrouping={chooseGrouping} />}
      <div style={{ overflowY: 'auto', minWidth: 0, minHeight: 0, padding: 8 }}>
        {environmentError && <div role="alert" style={{ padding: '4px 10px', fontSize: 11, color: colors.statusError }}>{environmentError}</div>}
        {creating && <div role="status" style={{ padding: '4px 10px', fontSize: 11, color: colors.textSecondary }}>Opening the conversation…</div>}
        {view === 'projects' && <ProjectRows groups={projectGroups} collapsed={collapsedGroups} indexOf={indexOfRow} highlighted={highlighted} colors={colors} showMachines={multi} actingEnvironment={actingEnvironmentFor} onHover={setHighlighted} onChoose={chooseProject} onToggleGroup={toggleGroup} />}
        {view === 'branches' && <BranchRows branches={branchMatches} highlighted={highlighted} loading={branchLoading} error={branchError} currentBranch={currentBranch} colors={colors} onHover={setHighlighted} onChoose={(branch) => { if (workspace) { setWorkspace({ ...workspace, useWorktree: true, sourceBranch: branch }); setQuery(''); setView('profiles') } }} />}
        {view === 'profiles' && workspace && <ProfileRows profiles={profileMatches} highlighted={highlighted} colors={colors} onHover={setHighlighted} onPlain={() => createConversation(workspace)} onProfile={(profileId) => { const profile = profiles.find((item) => item.id === profileId); if (profile) createConversation(workspace, profile) }} />}
      </div>
      <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, padding: '8px 12px', color: colors.textTertiary, fontSize: 11 }}>Use ↑ ↓ and Enter to select{view === 'projects' && multi && effectiveGrouping !== 'by-host' ? ', ← → to pick the machine' : ''}. Backspace returns to the prior step.</div>
    </motion.div>
  </motion.div>, layer)
}
