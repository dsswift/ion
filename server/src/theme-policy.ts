/**
 * Enterprise theme policy — server-side reader over the cached blob.
 *
 * The policy arrives through the engine's `get_enterprise_policy` RPC
 * (MDM-managed config: macOS managed-preferences plist etc.) and is a
 * read-only runtime constraint, never persisted to user settings. The theme
 * is a Device setting, so no server stores it: this reader exists to put the
 * policy on `desktop_settings_snapshot.themePolicy`, where a paired phone
 * reads it and enforces the same lock.
 */
import { enterprisePolicyCache } from './state'
import {
  deriveEnterpriseThemePolicy,
  type EnterpriseThemePolicy,
} from '@ion/shared/enterprise-theme-policy'

export type { EnterpriseThemePolicy }

/** The validated enterprise theme policy, or null when unmanaged. */
export function getEnterpriseThemePolicy(): EnterpriseThemePolicy | null {
  return deriveEnterpriseThemePolicy(enterprisePolicyCache.policy)
}
