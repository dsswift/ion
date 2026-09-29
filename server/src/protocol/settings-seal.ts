/**
 * Which setting keys a connection may not save, beyond the scope gate.
 *
 * Two enterprise rules reach a save:
 *
 *   - A SEALED key. `allowSettingsEdits` under an `agentSettingsEdits` seal
 *     (`customFields['ion-server']`) is the organization's value; a save
 *     that would change it is refused for every connection, admin included.
 *   - A HIDDEN group. `hiddenSettingsGroups` (device policy, local
 *     connection only) hides settings pages from the local desktop. Hiding a
 *     page is not enough when a client can still send the key, so the keys of
 *     a hidden group are refused for that connection too. Every key's page
 *     comes from the settings registry (`settingPage`), so no saved key is
 *     outside the rule.
 */
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import { deriveEnterpriseSettingsEditsPolicy } from '@ion/shared/enterprise-settings-edits-policy'
import { settingPage } from '@ion/shared/settings-registry'
import { computeSettingsHiddenGroups } from './settings-visibility'
import type { Connection } from './connection'

export type SettingsSealRefusal =
  | { code: 'settings_sealed'; keys: string[]; message: string }
  | { code: 'settings_hidden'; keys: string[]; message: string }

/** The settings page a key is shown on; `undefined` for a key with no page to hide. */
export function settingGroupOf(key: string): string | undefined {
  const page = settingPage(key)
  return page === undefined || page === 'none' ? undefined : page
}

/** Keys the enterprise policy seals to a fixed value. */
export function sealedSettingKeys(policy: EnterprisePolicy | null): string[] {
  return deriveEnterpriseSettingsEditsPolicy(policy) ? ['allowSettingsEdits'] : []
}

/**
 * Why `keys` may not be saved by `conn`, or null. Checked against the keys
 * whose value would change, so repeating what is on disk is never a refusal.
 */
export function settingsSealRefusal(
  conn: Pick<Connection, 'transport'>,
  policy: EnterprisePolicy | null,
  keys: readonly string[],
): SettingsSealRefusal | null {
  const sealed = new Set(sealedSettingKeys(policy))
  const sealedHit = keys.filter((k) => sealed.has(k))
  if (sealedHit.length > 0) {
    return { code: 'settings_sealed', keys: sealedHit, message: `${sealedHit.join(', ')} is set by your organization and cannot be changed here` }
  }
  const hidden = new Set(computeSettingsHiddenGroups(conn, policy))
  if (hidden.size === 0) return null
  const hiddenHit = keys.filter((k) => { const g = settingGroupOf(k); return g !== undefined && hidden.has(g) })
  if (hiddenHit.length > 0) {
    return { code: 'settings_hidden', keys: hiddenHit, message: `${hiddenHit.join(', ')} belongs to a settings group your organization has hidden on this device` }
  }
  return null
}
