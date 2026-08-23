import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, MagnifyingGlass } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { orderedProjects } from '../../shared/project-registry'
import { rError, rInfo } from '../rendererLogger'
import { filterDirectoryNames, filterProjects, isDirectoryBrowseQuery, joinDirectoryPath, parseDirectoryBrowseQuery } from './new-conversation-project-search'
import { filterBranches, filterConversationWorktrees, inventoryEntryToWorktree } from './new-conversation-workspaces'
import { BranchRows, DirectoryRows, ProfileRows, ProjectRows, WorkspaceRows } from './NewConversationPickerRows'
import type { EngineDirListing, EngineProfile, WorktreeInfo, WorktreeInventoryEntry } from '../../shared/types'
import type { NewConversationPickerTarget } from './new-conversation-picker-target'

type PickerView = 'projects' | 'workspaces' | 'branches' | 'profiles'
type WorkspaceChoice = { directory: string; worktree?: WorktreeInfo; useWorktree?: boolean; sourceBranch?: string }

interface NewConversationPickerProps extends NewConversationPickerTarget {
  onClose(): void
}

/** One new-conversation flow: project, workspace, then allowed profile. */
export function NewConversationPicker({ initialDirectory, initialWorktree, initialUseWorktree = false, initialSourceBranch, onClose }: NewConversationPickerProps): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const inputRef = useRef<HTMLInputElement>(null)
  const requestId = useRef(0)
  const [view, setView] = useState<PickerView>(() => {
    if (!initialDirectory) return 'projects'
    return initialUseWorktree && !initialSourceBranch ? 'branches' : 'profiles'
  })
  const [projectDirectory, setProjectDirectory] = useState(initialDirectory ?? '')
  const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(() => initialDirectory
    ? { directory: initialDirectory, worktree: initialWorktree, useWorktree: initialUseWorktree, sourceBranch: initialSourceBranch }
    : null)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<EngineDirListing | null>(null)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<WorktreeInventoryEntry[]>([])
  const [projectIsRepo, setProjectIsRepo] = useState(false)
  const [worktreeLoading, setWorktreeLoading] = useState(false)
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const registry = usePreferencesStore((state) => state.projects)
  const profiles = usePreferencesStore((state) => state.engineProfiles)
  const enterprisePolicy = usePreferencesStore((state) => state.enterpriseNewConversationDefaults)
  const addProject = usePreferencesStore((state) => state.addProject)

  const projectMatches = useMemo(() => filterProjects(orderedProjects(registry), query), [registry, query])
  const browse = useMemo(() => parseDirectoryBrowseQuery(query), [query])
  const browsing = view === 'projects' && isDirectoryBrowseQuery(query)
  const directoryNames = useMemo(() => filterDirectoryNames(
    (listing?.entries ?? []).filter((entry) => entry.isDir && entry.readable).map((entry) => entry.name),
    browse?.filter ?? '',
  ), [browse?.filter, listing?.entries])
  const selectedDirectory = useMemo(() => {
    if (!browsing || !browse || !listing) return null
    if (browse.hasTrailingSeparator || browse.filter === '') return listing.path
    const exact = listing.entries.find((entry) => entry.isDir && entry.readable && entry.name === browse.filter)
    return exact ? joinDirectoryPath(listing.path, exact.name) : null
  }, [browse, browsing, listing])
  const worktreeMatches = useMemo(() => filterConversationWorktrees(worktrees, query), [query, worktrees])
  const branchMatches = useMemo(() => filterBranches(branches, query), [branches, query])
  const profileMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return profiles.filter((profile) => !needle || profile.name.toLocaleLowerCase().includes(needle) || profile.extensions.some((extension) => extension.toLocaleLowerCase().includes(needle)))
  }, [profiles, query])

  useEffect(() => {
    rInfo('new-conversation-picker', 'opened', {
      initial_view: !initialDirectory ? 'projects' : initialUseWorktree && !initialSourceBranch ? 'branches' : 'profiles',
    })
    inputRef.current?.focus()
  }, [initialDirectory, initialSourceBranch, initialUseWorktree])

  useEffect(() => { setHighlighted(0) }, [view, query])

  useEffect(() => {
    if (!browsing || !browse) {
      setListing(null); setDirectoryError(null); setDirectoryLoading(false)
      return
    }
    const id = ++requestId.current
    setDirectoryLoading(true); setDirectoryError(null)
    void window.ion.listEngineDirectory(browse.parentPath, false).then((result) => {
      if (requestId.current !== id) return
      if (!result.ok || !result.data) throw new Error(result.error || `Could not list ${browse.parentPath}`)
      setListing(result.data)
      rInfo('new-conversation-picker', 'directory loaded', { path: result.data.path, entry_count: result.data.entries.length, truncated: result.data.truncated })
    }).catch((error: unknown) => {
      if (requestId.current !== id) return
      setListing(null); setDirectoryError(String(error))
      rError('new-conversation-picker', 'directory load failed', { path: browse.parentPath, error: String(error) })
    }).finally(() => { if (requestId.current === id) setDirectoryLoading(false) })
  }, [browse, browsing])

  useEffect(() => {
    if (view !== 'workspaces' || !projectDirectory) return
    const id = ++requestId.current
    setWorktreeLoading(true); setWorktreeError(null)
    void Promise.all([window.ion.gitIsRepo(projectDirectory), window.ion.gitWorktreeInventory(projectDirectory)]).then(([repo, result]) => {
      if (requestId.current !== id) return
      setProjectIsRepo(repo.isRepo)
      setWorktrees(result.worktrees)
      rInfo('new-conversation-picker', 'worktrees loaded', { project_path: projectDirectory, count: result.worktrees.length })
    }).catch((error: unknown) => {
      if (requestId.current !== id) return
      setProjectIsRepo(false); setWorktrees([]); setWorktreeError(String(error))
      rError('new-conversation-picker', 'worktree load failed', { project_path: projectDirectory, error: String(error) })
    }).finally(() => { if (requestId.current === id) setWorktreeLoading(false) })
  }, [projectDirectory, view])

  useEffect(() => {
    if (view !== 'branches' || !projectDirectory) return
    const id = ++requestId.current
    setBranchLoading(true); setBranchError(null)
    void window.ion.gitFetch(projectDirectory).then((result) => {
      if (!result.ok) rError('new-conversation-picker', 'branch fetch failed', { project_path: projectDirectory, error: result.error ?? 'unknown' })
    }).catch((error: unknown) => rError('new-conversation-picker', 'branch fetch failed', { project_path: projectDirectory, error: String(error) }))
    void window.ion.gitBranches(projectDirectory).then((result) => {
      if (requestId.current !== id) return
      setBranches(result.branches.filter((branch) => !branch.isRemote).map((branch) => branch.name))
      setCurrentBranch(result.current)
      rInfo('new-conversation-picker', 'branches loaded', { project_path: projectDirectory, count: result.branches.length })
    }).catch((error: unknown) => {
      if (requestId.current !== id) return
      setBranches([]); setBranchError(String(error))
      rError('new-conversation-picker', 'branch load failed', { project_path: projectDirectory, error: String(error) })
    }).finally(() => { if (requestId.current === id) setBranchLoading(false) })
  }, [projectDirectory, view])

  const chooseProject = (directory: string, addToRegistry: boolean): void => {
    if (addToRegistry) { addProject(directory); rInfo('new-conversation-picker', 'project registered', { directory }) }
    setProjectDirectory(directory); setQuery(''); setView('workspaces')
    rInfo('new-conversation-picker', 'project selected', { directory, source: addToRegistry ? 'path' : 'registry' })
  }

  const createConversation = useCallback((choice: WorkspaceChoice, profile?: EngineProfile): void => {
    const policyProfile = enterprisePolicy?.locked ? enterprisePolicy.engineProfileId : undefined
    const profileId = policyProfile ?? profile?.id
    const policyDirectory = enterprisePolicy?.locked ? enterprisePolicy.baseDirectory : ''
    const directory = policyDirectory || choice.directory
    const workspaceChangedByPolicy = !!policyDirectory && policyDirectory !== choice.directory
    const opts = {
      ...(profileId ? { profileId } : {}),
      ...(!workspaceChangedByPolicy && {
        useWorktree: choice.useWorktree,
        sourceBranch: choice.sourceBranch,
        worktree: choice.worktree,
      }),
    }
    rInfo('new-conversation-picker', 'profile selected', {
      directory,
      profile_id: profileId ?? '',
      policy_locked: !!enterprisePolicy?.locked,
      workspace_changed_by_policy: workspaceChangedByPolicy,
    })
    if (enterprisePolicy?.locked) setQuery('')
    void useSessionStore.getState().createConversationTab(directory, opts).then(() => {
      rInfo('new-conversation-picker', 'conversation created', { directory, profile_id: profileId ?? '', use_worktree: !!choice.useWorktree, existing_worktree: !!choice.worktree })
    }).catch((error: unknown) => {
      rError('new-conversation-picker', 'conversation create failed', { directory, profile_id: profileId ?? '', error: String(error) })
    })
    onClose()
  }, [enterprisePolicy, onClose])

  const autoCreate = view === 'profiles' && workspace !== null && (enterprisePolicy?.locked === true || profiles.length === 0)
  const autoCreateStarted = useRef(false)
  useEffect(() => {
    if (!autoCreate || !workspace || autoCreateStarted.current) return
    autoCreateStarted.current = true
    rInfo('new-conversation-picker', 'skipping conversation type selection', {
      directory: workspace.directory,
      policy_locked: enterprisePolicy?.locked === true,
      available_profile_count: profiles.length,
    })
    createConversation(workspace)
  }, [autoCreate, createConversation, enterprisePolicy?.locked, profiles.length, workspace])

  const chooseWorkspace = (choice: WorkspaceChoice): void => {
    rInfo('new-conversation-picker', 'workspace selected', { directory: choice.directory, use_worktree: !!choice.useWorktree, source_branch: choice.sourceBranch ?? '', existing_worktree: !!choice.worktree })
    if (enterprisePolicy?.locked) {
      createConversation(choice)
      return
    }
    setWorkspace(choice); setQuery(''); setView('profiles')
  }

  const chooseExistingWorktree = (entry: WorktreeInventoryEntry): void => chooseWorkspace({
    directory: entry.worktreePath,
    worktree: inventoryEntryToWorktree(projectDirectory, entry),
  })

  const handleBack = (): void => {
    if (view === 'profiles') {
      if (initialDirectory) { onClose(); return }
      setWorkspace(null); setView('workspaces'); setQuery(''); return
    }
    if (view === 'branches') { setView('workspaces'); setQuery(''); return }
    if (view === 'workspaces') { setProjectDirectory(''); setView('projects'); setQuery(''); return }
    if (browsing) { setQuery(''); return }
    onClose()
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); handleBack() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const count = view === 'projects' ? (browsing ? directoryNames.length + (selectedDirectory ? 1 : 0) : projectMatches.length)
    : view === 'workspaces' ? worktreeMatches.length + 1 + (projectIsRepo ? 1 : 0)
      : view === 'branches' ? branchMatches.length
        : profileMatches.length + 1
  const selectHighlighted = (): void => {
    if (view === 'projects') {
      if (browsing) {
        if (selectedDirectory && highlighted === 0) chooseProject(selectedDirectory, true)
        else { const name = directoryNames[highlighted - (selectedDirectory ? 1 : 0)]; if (name && listing) setQuery(`${joinDirectoryPath(listing.path, name)}/`) }
      } else { const project = projectMatches[highlighted]; if (project) chooseProject(project.dir, false) }
      return
    }
    if (view === 'workspaces') {
      if (highlighted === 0) chooseWorkspace({ directory: projectDirectory })
      else if (projectIsRepo && highlighted === worktreeMatches.length + 1) { setView('branches'); setQuery('') }
      else { const entry = worktreeMatches[highlighted - 1]; if (entry) chooseExistingWorktree(entry) }
      return
    }
    if (view === 'branches') { const branch = branchMatches[highlighted]; if (branch) chooseWorkspace({ directory: projectDirectory, useWorktree: true, sourceBranch: branch }); return }
    if (!workspace) return
    if (highlighted === 0) createConversation(workspace)
    else { const profile = profileMatches[highlighted - 1]; if (profile) createConversation(workspace, profile) }
  }
  const handleInputKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted((value) => Math.min(value + 1, Math.max(0, count - 1))) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((value) => Math.max(value - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); selectHighlighted() }
    else if (event.key === 'Backspace' && query === '') { event.preventDefault(); handleBack() }
  }

  if (!layer || autoCreate) return null
  const placeholder = view === 'projects' ? 'Search projects or enter a path…' : view === 'workspaces' ? 'Search worktrees…' : view === 'branches' ? 'Search branches…' : 'Search conversation profiles…'
  return createPortal(<motion.div data-ion-ui role="dialog" aria-modal="true" aria-label="New conversation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 'max(16px, 10vh) 16px 16px', boxSizing: 'border-box', background: colors.scrim }}>
    <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.99 }} transition={{ duration: 0.14 }} onMouseDown={(event) => event.stopPropagation()} style={{ width: 560, maxWidth: '100%', maxHeight: '100%', minWidth: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`, borderRadius: 12, boxShadow: colors.popoverShadow }}>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${colors.popoverBorder}`, padding: '8px 10px', gap: 8 }}><button aria-label="Back" className="ion-focusable" onClick={handleBack} style={{ display: 'flex', alignItems: 'center', padding: 4, border: 'none', borderRadius: 5, background: 'transparent', color: colors.textSecondary, cursor: 'pointer' }}><ArrowLeft size={16} /></button><MagnifyingGlass size={16} color={colors.textTertiary} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleInputKey} placeholder={placeholder} spellCheck={false} aria-label="New conversation search" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: colors.textPrimary, fontSize: 14 }} /></div>
      <div style={{ overflowY: 'auto', minWidth: 0, minHeight: 0, padding: 8 }}>
        {view === 'projects' && (browsing ? <DirectoryRows loading={directoryLoading} error={directoryError} listing={listing} names={directoryNames} selectedDirectory={selectedDirectory} highlighted={highlighted} colors={colors} onHover={setHighlighted} onChooseDirectory={() => selectedDirectory && chooseProject(selectedDirectory, true)} onChooseEntry={(name) => listing && setQuery(`${joinDirectoryPath(listing.path, name)}/`)} /> : <ProjectRows projects={projectMatches} highlighted={highlighted} colors={colors} onHover={setHighlighted} onChoose={(path) => chooseProject(path, false)} />)}
        {view === 'workspaces' && <WorkspaceRows repoPath={projectDirectory} worktrees={worktreeMatches} canCreateWorktree={projectIsRepo} highlighted={highlighted} loading={worktreeLoading} error={worktreeError} colors={colors} onHover={setHighlighted} onSource={() => chooseWorkspace({ directory: projectDirectory })} onWorktree={chooseExistingWorktree} onNewWorktree={() => { setView('branches'); setQuery('') }} />}
        {view === 'branches' && <BranchRows branches={branchMatches} highlighted={highlighted} loading={branchLoading} error={branchError} currentBranch={currentBranch} colors={colors} onHover={setHighlighted} onChoose={(branch) => chooseWorkspace({ directory: projectDirectory, useWorktree: true, sourceBranch: branch })} />}
        {view === 'profiles' && workspace && <ProfileRows profiles={profileMatches} highlighted={highlighted} colors={colors} onHover={setHighlighted} onPlain={() => createConversation(workspace)} onProfile={(profileId) => { const profile = profiles.find((item) => item.id === profileId); if (profile) createConversation(workspace, profile) }} />}
      </div>
      <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, padding: '8px 12px', color: colors.textTertiary, fontSize: 11 }}>Use ↑ ↓ and Enter to select. Backspace returns to the prior step.</div>
    </motion.div>
  </motion.div>, layer)
}
