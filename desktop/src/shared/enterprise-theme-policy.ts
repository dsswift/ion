/**
 * Pure derivation of the enterprise theme policy from the enterprise blob.
 *
 * Shared between the main process (main/theme-policy.ts reads it off the
 * startup cache) and the renderer (preferences-bootstrap / settings UI read
 * it off the store's `enterprisePolicy`), so both surfaces validate the
 * MDM-supplied shape identically.
 *
 * Semantics of the two knobs:
 *   - `themeId` alone (locked absent/false): managed DEFAULT — applied when
 *     the user has never picked a theme, user may change it afterwards.
 *   - `locked: true`: enforced — the theme always applies and pickers are
 *     disabled, on the desktop and on paired iOS devices.
 */
import type { EnterprisePolicy, IonDesktopPolicyFields } from './types-engine'

export interface EnterpriseThemePolicy {
  themeId: string
  locked: boolean
}

export function deriveEnterpriseThemePolicy(
  policy: EnterprisePolicy | null | undefined,
): EnterpriseThemePolicy | null {
  const fields = (policy?.customFields?.['ion-desktop'] ?? {}) as IonDesktopPolicyFields
  const raw = fields.themePolicy
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.themeId !== 'string' || raw.themeId.length === 0) return null
  return { themeId: raw.themeId, locked: raw.locked === true }
}
