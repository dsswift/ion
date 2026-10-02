import type { EngineProfile, NewConversationDefaultsPolicy } from '@ion/shared/types'
import type { ProjectProfileOverride } from '@ion/shared/project-registry'

export type ConversationProfileAction =
  | { kind: 'plain'; source: string }
  | { kind: 'profile'; profileId: string; source: string }
  | { kind: 'picker'; source: string }

export interface ProjectProfileResolution {
  profileId?: string
  profileName?: string
  locked?: boolean
  source?: string
  status?: 'resolved' | 'missing' | 'ambiguous'
}

/**
 * Resolve the normal New Conversation profile action with explicit precedence.
 *
 * `defaultProfileId` is the person's default profile preference, the lowest
 * choice that still skips the picker. An unlocked enterprise policy reaches
 * this function only through it: the policy's profile seeds that preference
 * as a managed default.
 */
export function resolveConversationProfileAction(
  profiles: readonly EngineProfile[],
  override: ProjectProfileOverride | undefined,
  recommendation: ProjectProfileResolution | undefined,
  enterprisePolicy: NewConversationDefaultsPolicy | null,
  defaultProfileId = '',
): ConversationProfileAction {
  if (enterprisePolicy?.locked) {
    if (!enterprisePolicy.engineProfileId) return { kind: 'plain', source: 'enterprise-lock' }
    return { kind: 'profile', profileId: enterprisePolicy.engineProfileId, source: 'enterprise-lock' }
  }
  if (recommendation?.locked) {
    if (!recommendation.profileId) return { kind: 'picker', source: 'enterprise-project-profile-unavailable' }
    return { kind: 'profile', profileId: recommendation.profileId, source: recommendation.source ?? 'enterprise-project-lock' }
  }
  if (override?.kind === 'plain') return { kind: 'plain', source: 'user-project-override' }
  if (override?.kind === 'profile') {
    return profiles.some((item) => item.id === override.profileId)
      ? { kind: 'profile', profileId: override.profileId, source: 'user-project-override' }
      : { kind: 'picker', source: 'user-project-profile-unavailable' }
  }
  if (override?.kind !== 'ask' && recommendation?.status === 'resolved' && recommendation.profileId) {
    return { kind: 'profile', profileId: recommendation.profileId, source: recommendation.source ?? 'project-recommendation' }
  }
  if (profiles.length === 0) return { kind: 'plain', source: 'no-profiles' }
  if (override?.kind !== 'ask' && defaultProfileId && profiles.some((item) => item.id === defaultProfileId)) {
    return { kind: 'profile', profileId: defaultProfileId, source: 'default-profile' }
  }
  return { kind: 'picker', source: override?.kind === 'ask' ? 'user-project-ask' : 'no-default' }
}
