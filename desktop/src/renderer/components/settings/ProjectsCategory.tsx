import React from 'react'
import { FolderPlus, Star, Trash } from '@phosphor-icons/react'
import { defaultProject, effectiveProjects, type ManagedProject, type ProjectProfileOverride } from '../../../shared/project-registry'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { rError } from '../../rendererLogger'
import { pickDirectoryForSession } from '../../stores/remote-fs-store'
import { SettingHeading } from './SettingHeading'
import { SettingSection } from './SettingSection'

const ASK_VALUE = 'ask'
const PLAIN_VALUE = 'plain'

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

export function ProjectsCategory() {
  const colors = useColors()
  const projects = usePreferencesStore((state) => state.projects)
  const enterprisePolicy = usePreferencesStore((state) => state.enterprisePolicy)
  const engineProfiles = usePreferencesStore((state) => state.engineProfiles)
  const addProject = usePreferencesStore((state) => state.addProject)
  const removeProject = usePreferencesStore((state) => state.removeProject)
  const setDefaultProject = usePreferencesStore((state) => state.setDefaultProject)
  const setProjectName = usePreferencesStore((state) => state.setProjectName)
  const setProjectProfileOverride = usePreferencesStore((state) => state.setProjectProfileOverride)

  const managedProjects: ManagedProject[] = (enterprisePolicy?.newConversationDefaults?.projects ?? []).map((project) => ({
    directory: project.directory,
    name: project.name,
    isDefault: project.default,
    profileAction: project.profileName ? 'profile' : 'ask',
    profileSource: project.profileName ? 'enterprise-project' : undefined,
  }))
  const projectEntries = effectiveProjects(projects, managedProjects)
  const defaultDirectory = defaultProject(projects, managedProjects)?.dir
  const knownProfileIds = new Set(engineProfiles.map((profile) => profile.id))

  const handleAddProject = async (): Promise<void> => {
    const directory = await pickDirectoryForSession({ currentPath: defaultDirectory })
    if (directory) addProject(directory)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    padding: '7px 10px',
    background: colors.surfacePrimary,
    color: colors.textPrimary,
    border: `1px solid ${colors.inputBorder}`,
    borderRadius: 7,
    fontSize: 12,
    outline: 'none',
  }

  const iconButtonStyle: React.CSSProperties = {
    background: colors.surfacePrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 7,
    padding: 7,
    cursor: 'pointer',
    color: colors.textSecondary,
    display: 'flex',
    alignItems: 'center',
  }

  return (
    <>
      <SettingHeading first>Projects</SettingHeading>
      <SettingSection
        label="Project directories"
        description="Projects are available when you start a new conversation. The starred project opens by default."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projectEntries.map((project) => {
            const isDefault = project.dir === defaultDirectory
            return (
              <div
                key={project.dir}
                style={{
                  padding: 10,
                  border: `1px solid ${colors.containerBorder}`,
                  borderRadius: 9,
                  background: colors.surfacePrimary,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    aria-label={isDefault ? `Clear ${project.displayName} as default project` : `Set ${project.displayName} as default project`}
                    aria-pressed={isDefault}
                    onClick={() => setDefaultProject(isDefault ? null : project.dir)}
                    disabled={project.managed}
                    style={{ ...iconButtonStyle, color: isDefault ? colors.accent : colors.textTertiary, opacity: project.managed ? 0.55 : 1, cursor: project.managed ? 'default' : 'pointer' }}
                  >
                    <Star size={16} weight={isDefault ? 'fill' : 'regular'} />
                  </button>
                  <input
                    aria-label={`${project.displayName} project name`}
                    value={project.entry.name ?? ''}
                    placeholder={project.displayName}
                    onChange={(event) => setProjectName(project.dir, event.target.value)}
                    disabled={project.managed}
                    style={{ ...inputStyle, flex: 1, opacity: project.managed ? 0.65 : 1 }}
                  />
                  <button
                    aria-label={`Remove ${project.displayName} project`}
                    onClick={() => removeProject(project.dir)}
                    disabled={project.managed}
                    style={{ ...iconButtonStyle, color: colors.textTertiary, opacity: project.managed ? 0.55 : 1, cursor: project.managed ? 'default' : 'pointer' }}
                  >
                    <Trash size={16} />
                  </button>
                </div>
                <div
                  style={{
                    marginTop: 7,
                    color: colors.textTertiary,
                    fontFamily: 'monospace',
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {project.dir}
                </div>
                  {project.managed && <div style={{ marginTop: 5, color: colors.accent, fontSize: 11 }}>Managed by enterprise policy</div>}
                <select
                  aria-label={`${project.displayName} profile`}
                  value={profileValue(project.entry.profileOverride, knownProfileIds)}
                  onChange={(event) => setProjectProfileOverride(project.dir, profileOverride(event.target.value))}
                  disabled={project.managed}
                  style={{ ...inputStyle, marginTop: 8, opacity: project.managed ? 0.65 : 1 }}
                >
                  <option value={ASK_VALUE}>Ask each time</option>
                  <option value={PLAIN_VALUE}>Plain conversation</option>
                  {engineProfiles.map((profile) => (
                    <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>
                  ))}
                </select>
              </div>
            )
          })}
          {projectEntries.length === 0 && (
            <div style={{ padding: '12px 0', color: colors.textTertiary, fontSize: 12 }}>
              Add a project directory to start.
            </div>
          )}
          <button
            aria-label="Add project"
            onClick={() => { void handleAddProject().catch((error: unknown) => rError('settings', 'add project failed', { error: String(error) })) }}
            style={{
              alignSelf: 'flex-start',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              borderRadius: 7,
              padding: '7px 10px',
              cursor: 'pointer',
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <FolderPlus size={16} />
            Add project
          </button>
        </div>
      </SettingSection>
    </>
  )
}
