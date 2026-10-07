import { usePreferencesStore } from '../persistence/preferences'
import { activeNewConversationLock } from '../new-conversation-lock'
import { profileOverrideProfileId } from '@ion/shared/project-registry'

export interface NewTabDefaults {
  workingDirectory: string
  hasChosenDirectory: boolean
  engineProfileId: string | null
}

/**
 * Where a conversation the server opens by itself starts, and on which engine
 * profile. The server opens one when a person has none (a settled last
 * conversation, a closed last tab, a first sign-in), with no client to ask.
 *
 * Precedence: the enterprise lock, then the default project and its profile,
 * then the default base directory, then the server's own home directory. The
 * last is the only case that leaves the directory unchosen.
 */
export function newTabDefaults(homeDir: string): NewTabDefaults {
  const prefs = usePreferencesStore.getState()
  const lock = activeNewConversationLock()
  if (lock?.baseDirectory) {
    return { workingDirectory: lock.baseDirectory, hasChosenDirectory: true, engineProfileId: lock.engineProfileId || null }
  }
  const projects = prefs.projects ?? {}
  const defaultDirectory = Object.keys(projects).find((dir) => projects[dir]?.isDefault === true)
  if (defaultDirectory) {
    const profileId = lock ? lock.engineProfileId : profileOverrideProfileId(projects[defaultDirectory]?.profileOverride)
    const known = !!profileId && prefs.engineProfiles.some((profile) => profile.id === profileId)
    return { workingDirectory: defaultDirectory, hasChosenDirectory: true, engineProfileId: known ? profileId! : null }
  }
  const base = prefs.defaultBaseDirectory
  return { workingDirectory: base || homeDir, hasChosenDirectory: !!base, engineProfileId: lock?.engineProfileId || null }
}
