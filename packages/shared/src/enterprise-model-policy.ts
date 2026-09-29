/**
 * Whether an Environment's enterprise policy permits a model.
 *
 * The engine is the enforcer: it refuses a prompt whose model the policy
 * forbids (`IsModelAllowed`, engine/internal/config/merge.go). This is the
 * same rule, for the places that choose or offer a model BEFORE the engine
 * sees it, so they never choose or offer one the engine will refuse. A
 * blocked model is refused even when it is also on the allowlist, and an
 * empty allowlist allows everything that is not blocked.
 */
import type { EnterprisePolicy } from './types-enterprise'

export type ModelPolicy = Pick<EnterprisePolicy, 'allowedModels' | 'blockedModels'>

export function isModelAllowedByPolicy(modelId: string, policy: ModelPolicy | null | undefined): boolean {
  if (!policy) return true
  if (policy.blockedModels?.includes(modelId)) return false
  if (policy.allowedModels && policy.allowedModels.length > 0 && !policy.allowedModels.includes(modelId)) return false
  return true
}
