/**
 * Pure derivation of the enterprise theme policy from the enterprise blob.
 *
 * Shared between the main process (main/theme-policy.ts reads it off the
 * startup cache) and the renderer (preferences-bootstrap / settings UI read
 * it off the store's `enterprisePolicy`), so both surfaces validate the
 * MDM-supplied shape identically.
 *
 * Semantics of the two knobs:
 *   - `themeId` alone (locked absent/false): managed DEFAULT — seeds the
 *     user's theme once per published value (`./managed-defaults`); the user
 *     may change it afterwards.
 *   - `locked: true`: enforced — the theme always applies and pickers are
 *     disabled, on the desktop and on paired iOS devices.
 *
 * A `settingsPolicy` entry for `selectedTheme` says the same two things with
 * the general classes: `managed-default` with a value, and `sealed` with one.
 */
import type { EnterprisePolicy } from './types-engine'
import { resolveSettingMutability } from './enterprise-settings-policy'

export interface EnterpriseThemePolicy {
  themeId: string
  locked: boolean
}

export function deriveEnterpriseThemePolicy(
  policy: EnterprisePolicy | null | undefined,
): EnterpriseThemePolicy | null {
  // One resolver for both spellings: the `themePolicy` block, and a
  // `settingsPolicy` entry for `selectedTheme`, which outranks it. A class
  // that supplies no theme id has no theme to enforce or suggest.
  const mutability = resolveSettingMutability(policy, 'selectedTheme')
  if (mutability.class === 'user-adjustable' || !mutability.hasValue) return null
  if (typeof mutability.value !== 'string' || mutability.value.length === 0) return null
  return { themeId: mutability.value, locked: mutability.class === 'sealed' }
}

/**
 * The theme id that must render: the enforced id under a locked policy,
 * otherwise the user's own choice. The user's choice is never replaced, so
 * it resumes when the lock lifts.
 */
export function resolveEffectiveThemeId(
  policy: EnterprisePolicy | null | undefined,
  userChoice: string,
): string {
  const themePolicy = deriveEnterpriseThemePolicy(policy)
  return themePolicy?.locked ? themePolicy.themeId : userChoice
}
