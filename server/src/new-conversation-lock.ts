/**
 * The enterprise new-conversation lock, as the server enforces it.
 *
 * `enterprise.newConversationDefaults.locked` already steers the client's
 * New Conversation picker, and the engine already forces the locked profile
 * onto every session it starts. This module is the server's own half: where a
 * conversation opens, and which actions would let someone choose their own
 * directory or add a project, follow the same policy whichever client asked.
 * A client that ignores the lock gets refused here rather than trusted.
 */
import { enterprisePolicyCache } from './enterprise-policy-state'

export interface NewConversationLock {
  /** Where every new conversation opens. Empty: the lock names no directory. */
  baseDirectory: string
  /** The engine profile every new conversation runs. Empty: plain conversations. */
  engineProfileId: string
}

/** The lock in force on this server, or null when the policy is absent or unlocked. */
export function activeNewConversationLock(): NewConversationLock | null {
  const defaults = enterprisePolicyCache.newConversationDefaults
  if (!defaults || defaults.locked !== true) return null
  return { baseDirectory: defaults.baseDirectory ?? '', engineProfileId: defaults.engineProfileId ?? '' }
}

/** Actions that create or change a project, or point an existing conversation at another directory. */
const ACTIONS_REFUSED_UNDER_LOCK: ReadonlySet<string> = new Set([
  'environment.projects.add',
  'environment.projects.clone',
  'environment.projects.remove',
  'environment.projects.relocate',
  'setBaseDirectory',
  'addDirectory',
])

/** Whether `action` is refused while the new-conversation lock is in force. */
export function refusedUnderNewConversationLock(action: string, lock: NewConversationLock | null): boolean {
  return lock !== null && ACTIONS_REFUSED_UNDER_LOCK.has(action)
}
