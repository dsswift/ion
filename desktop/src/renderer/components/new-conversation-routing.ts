import type { EngineProfile, NewConversationDefaultsPolicy } from '../../shared/types'
import type { ProjectProfileOverride } from '../../shared/project-registry'

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

/** Resolve the normal New Conversation profile action with explicit precedence. */
export function resolveConversationProfileAction(
  profiles: readonly EngineProfile[],
  override: ProjectProfileOverride | undefined,
  recommendation: ProjectProfileResolution | undefined,
  enterprisePolicy: NewConversationDefaultsPolicy | null,
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
  return { kind: 'picker', source: override?.kind === 'ask' ? 'user-project-ask' : 'no-default' }
}
