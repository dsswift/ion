/**
 * Enterprise theme policy — main-process reader over the cached blob.
 *
 * The policy arrives through the engine's `get_enterprise_policy` RPC
 * (MDM-managed config: macOS managed-preferences plist etc.) under
 * `customFields['ion-desktop'].themePolicy`, is cached in
 * `state.enterprisePolicyCache` at startup, and is a read-only runtime
 * constraint — never persisted to user settings. Enforcement points:
 *
 *   - `projectCurrentSettings()` overrides the projected `selectedTheme`
 *     when locked, so iOS renders the enforced value.
 *   - `persistAndBroadcastSettings()` strips locked `selectedTheme` writes
 *     from BOTH edit surfaces (renderer + iOS) at the single write funnel.
 *   - The renderer reads the same policy via `getEnterprisePolicyFull` and
 *     applies/locks the theme client-side (preferences-bootstrap).
 *   - The wire projects it on `desktop_settings_snapshot.themePolicy` so
 *     iOS enforces the same lock.
 */
import { enterprisePolicyCache } from './state'
import { log as _log } from './logger'
import {
  deriveEnterpriseThemePolicy,
  type EnterpriseThemePolicy,
} from '../shared/enterprise-theme-policy'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('themes', msg, fields)
}

export type { EnterpriseThemePolicy }

/** The validated enterprise theme policy, or null when unmanaged. */
export function getEnterpriseThemePolicy(): EnterpriseThemePolicy | null {
  return deriveEnterpriseThemePolicy(enterprisePolicyCache.policy)
}

/** True when a locked policy forbids user theme changes. */
export function isThemeLocked(): boolean {
  const policy = getEnterpriseThemePolicy()
  if (policy?.locked) {
    log('theme change gated by enterprise lock', { theme_id: policy.themeId })
    return true
  }
  return false
}
