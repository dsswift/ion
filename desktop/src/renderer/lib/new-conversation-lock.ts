/**
 * What the enterprise new-conversation lock takes away from the person, read
 * from the policy the client already holds (`enterpriseNewConversationDefaults`,
 * fetched from the server at startup). One reader, so every control that offers
 * a folder, a project, or a profile asks the same question.
 *
 * Folder and project choices go only when the lock names a directory: a lock
 * on the profile alone leaves the person free to choose where.
 */
import type { NewConversationDefaultsPolicy } from '@ion/shared/types'
import { usePreferencesStore } from '../preferences'

export interface NewConversationLock {
  /** Where every new conversation opens. Empty: the lock names no directory. */
  directory: string
  /** The profile every new conversation runs. Empty: plain conversations. */
  profileId: string
  /** The person may not choose a folder, add or change a project, or cut a worktree. */
  foldersLocked: boolean
}

/** The lock a policy carries, or null when the policy is absent or only suggests defaults. */
export function newConversationLockOf(policy: NewConversationDefaultsPolicy | null | undefined): NewConversationLock | null {
  if (!policy || policy.locked !== true) return null
  const directory = policy.baseDirectory ?? ''
  return { directory, profileId: policy.engineProfileId ?? '', foldersLocked: directory !== '' }
}

/** The lock in force now, for code that runs outside a component. */
export function currentNewConversationLock(): NewConversationLock | null {
  return newConversationLockOf(usePreferencesStore.getState().enterpriseNewConversationDefaults)
}

/** The lock in force, re-read when the policy changes. */
export function useNewConversationLock(): NewConversationLock | null {
  const policy = usePreferencesStore((state) => state.enterpriseNewConversationDefaults)
  return newConversationLockOf(policy)
}
