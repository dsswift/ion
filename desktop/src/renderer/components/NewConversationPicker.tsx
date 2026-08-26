import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, MagnifyingGlass } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { defaultProject, effectiveProjects, type ManagedProject } from '../../shared/project-registry'
import { rError, rInfo } from '../rendererLogger'
import { filterProjects } from './new-conversation-project-search'
import { filterBranches } from './new-conversation-workspaces'
import { BranchRows, ProfileRows, ProjectRows } from './NewConversationPickerRows'
import { resolveConversationProfileAction } from './new-conversation-routing'
import type { EngineProfile } from '../../shared/types'
import type { NewConversationPickerTarget } from './new-conversation-picker-target'

type PickerView = 'projects' | 'branches' | 'profiles'
type WorkspaceChoice = { directory: string; projectDirectory: string; useWorktree?: boolean; sourceBranch?: string }

interface NewConversationPickerProps extends NewConversationPickerTarget {
  onClose(): void
}

/** Selects a controlled Project and conversation type. Worktree creation is explicit. */
export function NewConversationPicker({ initialDirectory, initialUseWorktree = false, initialSourceBranch, forceProfilePicker = false, onClose }: NewConversationPickerProps): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const inputRef = useRef<HTMLInputElement>(null)
  const autoCreateStarted = useRef(false)
  const registry = usePreferencesStore((state) => state.projects)
  const profiles = usePreferencesStore((state) => state.engineProfiles)
  const enterprisePolicy = usePreferencesStore((state) => state.enterpriseNewConversationDefaults)
  const fullEnterprisePolicy = usePreferencesStore((state) => state.enterprisePolicy)
  const managedProjects = useMemo<ManagedProject[]>(() => (fullEnterprisePolicy?.newConversationDefaults?.projects ?? []).map((project) => ({ directory: project.directory, name: project.name, isDefault: project.default, profileAction: project.profileName ? 'profile' : 'ask', profileSource: project.profileName ? 'enterprise-project' : undefined })), [fullEnterprisePolicy])
  const effectiveProjectList = useMemo(() => effectiveProjects(registry, managedProjects), [managedProjects, registry])
  const [view, setView] = useState<PickerView>(() => {
    if (initialDirectory) return initialUseWorktree && !initialSourceBranch ? 'branches' : 'profiles'
    return defaultProject(registry, managedProjects) ? 'profiles' : 'projects'
  })
  const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(() => {
    if (initialDirectory) return { directory: initialDirectory, projectDirectory: initialDirectory, useWorktree: initialUseWorktree, sourceBranch: initialSourceBranch }
    const project = defaultProject(registry, managedProjects)
    return project ? { directory: project.dir, projectDirectory: project.dir } : null
  })
  const [query, setQuery] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(0)

  const projectMatches = useMemo(() => filterProjects(effectiveProjectList, query), [effectiveProjectList, query])
  const branchMatches = useMemo(() => filterBranches(branches, query), [branches, query])
  const profileMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return profiles.filter((profile) => !needle || profile.name.toLocaleLowerCase().includes(needle))
  }, [profiles, query])
  const [recommendation, setRecommendation] = useState<{ profileId?: string; profileName?: string; profileLocked?: boolean; source?: string; status?: 'resolved' | 'missing' | 'ambiguous' } | undefined>()
  const selectedProject = workspace ? registry[workspace.projectDirectory] : undefined
  const fallbackOverride = selectedProject?.profileOverride
  const resolvedAction = useMemo(() => resolveConversationProfileAction(profiles, forceProfilePicker ? { kind: 'ask' } : fallbackOverride, recommendation, enterprisePolicy), [enterprisePolicy, fallbackOverride, forceProfilePicker, profiles, recommendation])

  useEffect(() => {
    rInfo('new-conversation-picker', 'opened', { initial_view: view, explicit_worktree: initialUseWorktree, has_default_project: !!defaultProject(registry, managedProjects) })
    inputRef.current?.focus()
  }, []) // First paint records the invocation context.

  useEffect(() => { setHighlighted(0) }, [view, query])

  useEffect(() => {
    if (!workspace) { setRecommendation(undefined); return }
    const resolve = window.ion.resolveNewConversationDefaults
    if (!resolve) { setRecommendation(undefined); return }
    let active = true
    void resolve(workspace.projectDirectory).then((result) => {
      if (!active) return
      if (!result) { setRecommendation(undefined); return }
      setRecommendation({ profileId: result.profileId, profileName: result.profileName, profileLocked: result.profileLocked, source: result.profileLocked ? 'enterprise-project-lock' : result.profileName ? 'project-recommendation' : undefined, status: result.profileName && !result.profileId ? 'missing' : 'resolved' })
    }).catch((error: unknown) => {
      if (!active) return
      setRecommendation(undefined)
      rError('new-conversation-picker', 'project default resolution failed', { project_path: workspace.projectDirectory, error: String(error) })
    })
    return () => { active = false }
  }, [workspace?.projectDirectory])

  useEffect(() => {
    if (view !== 'branches' || !workspace) return
    setBranchLoading(true); setBranchError(null)
    void window.ion.gitFetch(workspace.projectDirectory).catch((error: unknown) => rError('new-conversation-picker', 'branch fetch failed', { project_path: workspace.projectDirectory, error: String(error) }))
    void window.ion.gitBranches(workspace.projectDirectory).then((result) => {
      setBranches(result.branches.filter((branch) => !branch.isRemote).map((branch) => branch.name))
      setCurrentBranch(result.current)
      rInfo('new-conversation-picker', 'branches loaded', { project_path: workspace.projectDirectory, count: result.branches.length })
    }).catch((error: unknown) => {
      setBranches([]); setBranchError(String(error))
      rError('new-conversation-picker', 'branch load failed', { project_path: workspace.projectDirectory, error: String(error) })
    }).finally(() => setBranchLoading(false))
  }, [view, workspace])

  const createConversation = useCallback((choice: WorkspaceChoice, profile?: EngineProfile): void => {
    const locked = enterprisePolicy?.locked === true
    const directory = locked && enterprisePolicy.baseDirectory ? enterprisePolicy.baseDirectory : choice.directory
    const profileId = locked ? enterprisePolicy.engineProfileId : profile?.id ?? (resolvedAction.kind === 'profile' ? resolvedAction.profileId : '')
    const workspaceChanged = directory !== choice.directory
    const opts = {
      ...(profileId ? { profileId } : {}),
      ...(!workspaceChanged && { useWorktree: choice.useWorktree, sourceBranch: choice.sourceBranch }),
      projectDirectory: choice.projectDirectory,
    }
    rInfo('new-conversation-picker', 'conversation creation resolved', { directory, project_directory: choice.projectDirectory, profile_id: profileId, source: locked ? 'enterprise-lock' : profile ? 'explicit-profile' : resolvedAction.source, use_worktree: !!opts.useWorktree })
    void useSessionStore.getState().createConversationTab(directory, opts).then(() => {
      rInfo('new-conversation-picker', 'conversation created', { directory, project_directory: choice.projectDirectory, profile_id: profileId })
    }).catch((error: unknown) => rError('new-conversation-picker', 'conversation create failed', { directory, error: String(error) }))
    onClose()
  }, [enterprisePolicy, onClose, resolvedAction])

  useEffect(() => {
    if (view !== 'profiles' || !workspace || autoCreateStarted.current || resolvedAction.kind === 'picker') return
    autoCreateStarted.current = true
    createConversation(workspace)
  }, [createConversation, resolvedAction, view, workspace])

  const chooseProject = (directory: string): void => {
    const choice = { directory, projectDirectory: directory }
    setWorkspace(choice); setQuery('')
    if (initialUseWorktree) setView('branches')
    else setView('profiles')
    rInfo('new-conversation-picker', 'project selected', { directory, explicit_worktree: initialUseWorktree })
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

  const count = view === 'projects' ? projectMatches.length : view === 'branches' ? branchMatches.length : profileMatches.length + 1
  const selectHighlighted = (): void => {
    if (view === 'projects') { const project = projectMatches[highlighted]; if (project) chooseProject(project.dir); return }
    if (view === 'branches') { const branch = branchMatches[highlighted]; if (branch && workspace) { setWorkspace({ ...workspace, useWorktree: true, sourceBranch: branch }); setQuery(''); setView('profiles') }; return }
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

  if (!layer || (view === 'profiles' && resolvedAction.kind !== 'picker')) return null
  const placeholder = view === 'projects' ? 'Search projects…' : view === 'branches' ? 'Search branches…' : 'Search conversation profiles…'
  return createPortal(<motion.div data-ion-ui role="dialog" aria-modal="true" aria-label="New conversation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 'max(16px, 10vh) 16px 16px', boxSizing: 'border-box', background: colors.scrim }}>
    <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.99 }} transition={{ duration: 0.14 }} onMouseDown={(event) => event.stopPropagation()} style={{ width: 560, maxWidth: '100%', maxHeight: '100%', minWidth: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`, borderRadius: 12, boxShadow: colors.popoverShadow }}>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${colors.popoverBorder}`, padding: '8px 10px', gap: 8 }}><button aria-label="Back" className="ion-focusable" onClick={handleBack} style={{ display: 'flex', alignItems: 'center', padding: 4, border: 'none', borderRadius: 5, background: 'transparent', color: colors.textSecondary, cursor: 'pointer' }}><ArrowLeft size={16} /></button><MagnifyingGlass size={16} color={colors.textTertiary} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleInputKey} placeholder={placeholder} spellCheck={false} aria-label="New conversation search" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: colors.textPrimary, fontSize: 14 }} /></div>
      <div style={{ overflowY: 'auto', minWidth: 0, minHeight: 0, padding: 8 }}>
        {view === 'projects' && <ProjectRows projects={projectMatches} highlighted={highlighted} colors={colors} onHover={setHighlighted} onChoose={chooseProject} />}
        {view === 'branches' && <BranchRows branches={branchMatches} highlighted={highlighted} loading={branchLoading} error={branchError} currentBranch={currentBranch} colors={colors} onHover={setHighlighted} onChoose={(branch) => { if (workspace) { setWorkspace({ ...workspace, useWorktree: true, sourceBranch: branch }); setQuery(''); setView('profiles') } }} />}
        {view === 'profiles' && workspace && <ProfileRows profiles={profileMatches} highlighted={highlighted} colors={colors} onHover={setHighlighted} onPlain={() => createConversation(workspace)} onProfile={(profileId) => { const profile = profiles.find((item) => item.id === profileId); if (profile) createConversation(workspace, profile) }} />}
      </div>
      <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, padding: '8px 12px', color: colors.textTertiary, fontSize: 11 }}>Use ↑ ↓ and Enter to select. Backspace returns to the prior step.</div>
    </motion.div>
  </motion.div>, layer)
}
