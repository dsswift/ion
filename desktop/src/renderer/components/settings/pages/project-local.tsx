/**
 * project-local — what only this device's projects carry: the default
 * project, the New Conversation profile choice, the workspace folders, and
 * the projects enterprise policy manages. All of it lives in this device's
 * preferences store, so it shows on the local server's Projects page only.
 */
import React, { useEffect, useState } from 'react'
import { Folders, X } from '@phosphor-icons/react'
import type { ManagedProject, ProjectProfileOverride } from '@ion/shared/project-registry'
import { pickDirectoryForSession } from '@ion/server/store/remote-fs-store'
import { useColors } from '../../../theme'
import { usePreferencesStore } from '../../../preferences'
import { Button, CellText, Chip, DataList, IconButton, KIT, MonoLine, Muted, Select, Stack, TextInput } from '../kit'
import { rError, rInfo } from '../../../rendererLogger'

const ASK_VALUE = 'ask'
const PLAIN_VALUE = 'plain'
/** Stable empty list: a fresh [] out of the selector would re-render forever. */
const NO_FOLDERS: string[] = []

function profileValue(override: ProjectProfileOverride | undefined, knownProfileIds: Set<string>): string {
  if (override?.kind === 'plain') return PLAIN_VALUE
  if (override?.kind === 'profile' && knownProfileIds.has(override.profileId)) return `profile:${override.profileId}`
  return ASK_VALUE
}

function profileOverride(value: string): ProjectProfileOverride {
  if (value === PLAIN_VALUE) return { kind: 'plain' }
  if (value.startsWith('profile:')) return { kind: 'profile', profileId: value.slice('profile:'.length) }
  return { kind: 'ask' }
}

/** Which local project is the default, and the setter. */
export function useDefaultProject(): { isDefault(dir: string): boolean; setDefault(dir: string | null): void } {
  const projects = usePreferencesStore((state) => state.projects)
  const setDefaultProject = usePreferencesStore((state) => state.setDefaultProject)
  return { isDefault: (dir) => projects[dir]?.isDefault === true, setDefault: setDefaultProject }
}

export function ProjectProfileSelect({ dir, displayName }: { dir: string; displayName: string }): React.JSX.Element {
  const entry = usePreferencesStore((state) => state.projects[dir])
  const engineProfiles = usePreferencesStore((state) => state.engineProfiles)
  const setProjectProfileOverride = usePreferencesStore((state) => state.setProjectProfileOverride)
  const known = new Set(engineProfiles.map((profile) => profile.id))
  return (
    <Select aria-label={`${displayName} profile`} width={200} value={profileValue(entry?.profileOverride, known)} onChange={(event) => setProjectProfileOverride(dir, profileOverride(event.target.value))}>
      <option value={ASK_VALUE}>Ask each time</option>
      <option value={PLAIN_VALUE}>Plain conversation</option>
      {engineProfiles.map((profile) => <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>)}
    </Select>
  )
}

const FILE_DEFAULT = 'file'

/**
 * The worktree choice New Conversation remembers for this project: the
 * source branch, and whether the worktree is ephemeral. With no branch saved,
 * a worktree conversation asks for one; with no ephemeral answer saved, the
 * project's `.ion/worktree.json` decides.
 */
export function ProjectWorktreeDefaults({ dir, displayName }: { dir: string; displayName: string }): React.JSX.Element {
  const savedBranch = usePreferencesStore((state) => state.worktreeBranchDefaults[dir] ?? '')
  const ephemeral = usePreferencesStore((state) => state.projects[dir]?.worktreeEphemeral)
  const setWorktreeBranchDefault = usePreferencesStore((state) => state.setWorktreeBranchDefault)
  const removeWorktreeBranchDefault = usePreferencesStore((state) => state.removeWorktreeBranchDefault)
  const setProjectWorktreeEphemeral = usePreferencesStore((state) => state.setProjectWorktreeEphemeral)
  const [branch, setBranch] = useState(savedBranch)
  useEffect(() => { setBranch(savedBranch) }, [savedBranch])
  const commitBranch = (): void => {
    const next = branch.trim()
    if (next === savedBranch) return
    if (next) setWorktreeBranchDefault(dir, next)
    else removeWorktreeBranchDefault(dir)
    rInfo('settings', 'project worktree branch changed', { project: dir, branch: next || null })
  }
  const ephemeralValue = ephemeral === undefined ? FILE_DEFAULT : ephemeral ? 'ephemeral' : 'kept'
  return (
    <Stack gap={6}>
      <TextInput
        aria-label={`${displayName} worktree branch`}
        mono
        width={200}
        placeholder="Ask each time"
        value={branch}
        onChange={(event) => setBranch(event.target.value)}
        onBlur={commitBranch}
        onKeyDown={(event) => { if (event.key === 'Enter') commitBranch() }}
      />
      <Select
        aria-label={`${displayName} worktree ephemeral`}
        width={200}
        value={ephemeralValue}
        onChange={(event) => {
          const value = event.target.value
          const next = value === FILE_DEFAULT ? undefined : value === 'ephemeral'
          setProjectWorktreeEphemeral(dir, next)
          rInfo('settings', 'project worktree ephemeral changed', { project: dir, ephemeral: next ?? null })
        }}
      >
        <option value={FILE_DEFAULT}>As .ion/worktree.json says</option>
        <option value="ephemeral">Ephemeral</option>
        <option value="kept">Kept</option>
      </Select>
    </Stack>
  )
}

/**
 * A project's workspace folders: the folders every checkout of the project
 * (the base repo, each worktree, each bench) mounts beside it.
 */
export function WorkspaceFolders({ dir, displayName }: { dir: string; displayName: string }): React.JSX.Element {
  const colors = useColors()
  const folders = usePreferencesStore((state) => state.workspaceFolders[dir] ?? NO_FOLDERS)
  const addWorkspaceFolder = usePreferencesStore((state) => state.addWorkspaceFolder)
  const removeWorkspaceFolder = usePreferencesStore((state) => state.removeWorkspaceFolder)
  const add = async (): Promise<void> => {
    const directory = await pickDirectoryForSession({ currentPath: dir })
    if (directory) addWorkspaceFolder(dir, directory)
  }
  return (
    <Stack gap={6}>
      {folders.length === 0 ? <Muted>No folders mounted beside it.</Muted> : (
        <div role="list" aria-label={`${displayName} workspace folders`} style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius + 2, overflow: 'hidden' }}>
          {folders.map((folder) => (
            <div key={folder} role="listitem" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: `0 4px 0 ${KIT.inset}px`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
              <div style={{ flex: 1, minWidth: 0 }}><MonoLine>{folder}</MonoLine></div>
              <IconButton icon={X} label={`Remove ${folder} from ${displayName}`} onClick={() => removeWorkspaceFolder(dir, folder)} />
            </div>
          ))}
        </div>
      )}
      <div>
        <Button icon={Folders} aria-label={`Add folder to ${displayName}`} onClick={() => { void add().catch((error: unknown) => rError('settings', 'add project folder failed', { project: dir, error: String(error) })) }}>Add folder</Button>
      </div>
    </Stack>
  )
}

/** The projects enterprise policy sets; read-only, and absent when policy sets none. */
export function ManagedProjectsList(): React.JSX.Element | null {
  const enterprisePolicy = usePreferencesStore((state) => state.enterprisePolicy)
  const managed: ManagedProject[] = (enterprisePolicy?.newConversationDefaults?.projects ?? []).map((project) => ({
    directory: project.directory,
    name: project.name,
    isDefault: project.default,
    profileAction: project.profileName ? 'profile' : 'ask',
    profileId: undefined,
    profileSource: project.profileName ? 'enterprise-project' : undefined,
  }))
  if (managed.length === 0) return null
  return (
    <DataList
      label="Managed projects"
      title="Managed by your organization"
      description="Set by enterprise policy. They cannot be changed here."
      items={managed}
      getKey={(p) => p.directory}
      noun={['project', 'projects']}
      columns={[
        { id: 'name', render: (p) => <CellText>{p.name ?? p.directory.split('/').pop() ?? p.directory}</CellText> },
        { id: 'default', width: 'auto', render: (p) => (p.isDefault ? <Chip tone="accent">default</Chip> : null) },
        { id: 'path', width: 'minmax(0, 1.4fr)', render: (p) => <MonoLine>{p.directory}</MonoLine> },
      ]}
    />
  )
}
