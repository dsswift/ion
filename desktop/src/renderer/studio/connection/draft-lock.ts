/**
 * draft-lock — the device-policy refusal for a new conversation's
 * environment. Kept as a small pure module (rather than folded into
 * `NewConversationPicker.tsx`) so the rule can be tested without mounting
 * the picker component.
 *
 * The picker holds no draft environment of its own: where a conversation
 * opens is decided by the one click that opens it (a row, a machine chip,
 * or the worktree the picker was opened from), so there is nothing to lock.
 */
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { DesktopEnvironmentPolicy } from '@ion/shared/enterprise-environment-policy'

/**
 * Refuses a draft targeting the local environment when the device policy's
 * `central-only` mode is active (spec 14: "local drafts refused"). Every
 * other mode and every non-local target are unaffected.
 */
export function refusalForDraftEnvironment(environmentId: string, policy: DesktopEnvironmentPolicy): string | null {
  if (environmentId === LOCAL_ENVIRONMENT_ID && policy.mode === 'central-only') {
    return 'policy_disallowed: this device is restricted to central environments only'
  }
  return null
}
