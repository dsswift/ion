/**
 * Which setting keys a connection may not save, beyond the scope gate.
 *
 * Two enterprise rules reach a save:
 *
 *   - A SEALED key. The enterprise settings policy
 *     (`@ion/shared/enterprise-settings-policy`) resolves every key to a
 *     class; a save that would change a sealed one is refused, admin
 *     included. A key the server stores for itself (Environment, Account) is
 *     sealed for every connection. A Personal or Device key is under device
 *     policy, which is the local desktop's own: it is sealed for the local
 *     connection and for nothing else.
 *   - A HIDDEN group. `hiddenSettingsGroups` (device policy, local
 *     connection only) hides settings pages from the local desktop. Hiding a
 *     page is not enough when a client can still send the key, so the keys of
 *     a hidden group are refused for that connection too. Every key's page
 *     comes from the settings registry (`settingPage`), so no saved key is
 *     outside the rule.
 */
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import {
  governedSettingKeys,
  resolveSettingMutability,
  sealedSettingsMessage,
  settingsPolicyNamespace,
  type SettingMutability,
} from '@ion/shared/enterprise-settings-policy'
import { settingPage } from '@ion/shared/settings-registry'
import { computeSettingsHiddenGroups } from './settings-visibility'
import type { StudioActionError } from '@ion/shared/studio-wire/types'
import type { Connection } from './connection'

export type SettingsSealRefusal =
  | { code: 'settings_sealed'; keys: string[]; class: 'sealed'; message: string }
  | { code: 'settings_hidden'; keys: string[]; message: string }

/** The settings page a key is shown on; `undefined` for a key with no page to hide. */
export function settingGroupOf(key: string): string | undefined {
  const page = settingPage(key)
  return page === undefined || page === 'none' ? undefined : page
}

const UNGOVERNED: SettingMutability = { class: 'user-adjustable', hasValue: false, source: 'none' }

/**
 * The class in force for `key` on `conn`. A key the registry does not know
 * is one this server stores, so its own namespace classifies it.
 */
export function settingMutabilityFor(
  conn: Pick<Connection, 'transport'>,
  policy: EnterprisePolicy | null,
  key: string,
): SettingMutability {
  const namespace = settingsPolicyNamespace(key) ?? 'ion-server'
  if (namespace === 'ion-desktop' && conn.transport !== 'local') return UNGOVERNED
  return resolveSettingMutability(policy, key, namespace)
}

/** The keys this server stores that the enterprise policy seals, for every connection. */
export function sealedSettingKeys(policy: EnterprisePolicy | null): string[] {
  return governedSettingKeys(policy, 'ion-server').filter((key) => resolveSettingMutability(policy, key, 'ion-server').class === 'sealed')
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
  const sealedHit = keys.filter((k) => settingMutabilityFor(conn, policy, k).class === 'sealed')
  if (sealedHit.length > 0) {
    return { code: 'settings_sealed', keys: sealedHit, class: 'sealed', message: sealedSettingsMessage(sealedHit) }
  }
  const hidden = new Set(computeSettingsHiddenGroups(conn, policy))
  if (hidden.size === 0) return null
  const hiddenHit = keys.filter((k) => { const g = settingGroupOf(k); return g !== undefined && hidden.has(g) })
  if (hiddenHit.length > 0) {
    return { code: 'settings_hidden', keys: hiddenHit, message: `${hiddenHit.join(', ')} belongs to a settings group your organization has hidden on this device` }
  }
  return null
}

/** A refusal as the wire error a client reads: the code, the keys, and for a seal the class. */
export function sealRefusalError(refusal: SettingsSealRefusal): StudioActionError {
  return refusal.code === 'settings_sealed'
    ? { code: refusal.code, message: refusal.message, keys: refusal.keys, class: refusal.class }
    : { code: refusal.code, message: refusal.message, keys: refusal.keys }
}
