/**
 * Settings partition (Task 10): every settings-dialog category is either
 * `personal` (this device/subject's own preference, never hidden from its
 * owner) or `environment` (shared configuration for whoever runs this
 * server/engine -- models, providers, git operation policy, MCP servers,
 * team automation, org identity). A connection holding `admin` may change an
 * environment group's settings, from any transport. Separately, an enterprise
 * sealed config can hide any group from the local desktop by naming it in
 * `hiddenSettingsGroups`; that device policy never applies to a visiting
 * connection.
 *
 * Deliberately plain strings, not `ProjectableGroup` (`server/src/
 * projectable-settings-types.ts`) -- this table spans desktop-only
 * categories (`remote`, `environments`, `entra`, ...) that
 * are never projected to iOS, and `packages/shared` cannot import from
 * `server` (the dependency runs the other way). `server/src/__tests__/
 * settings-classification-completeness.test.ts` cross-checks this table
 * against `PROJECTABLE_GROUP_ORDER`, where both symbols are visible.
 */

import { isServerWrittenSettingKey, settingKeysInScope, settingScope } from './settings-registry'

export type SettingsClassification = 'personal' | 'environment'

interface SettingsGroupEntry {
  id: string
  classification: SettingsClassification
}

export const SETTINGS_GROUP_CLASSIFICATIONS: readonly SettingsGroupEntry[] = [
  // Projectable groups (server/src/projectable-settings-types.ts)
  { id: 'general', classification: 'personal' },
  { id: 'ai', classification: 'environment' }, // models/tiers, default provider
  { id: 'appearance', classification: 'personal' },
  { id: 'tabs', classification: 'personal' },
  { id: 'git', classification: 'environment' }, // git operation modes
  { id: 'quicktools', classification: 'personal' },
  { id: 'notifications', classification: 'personal' },
  { id: 'advanced', classification: 'environment' }, // watchers

  // Groups of sections the phone does not project (`settings-taxonomy.ts`)
  { id: 'projects', classification: 'personal' },
  { id: 'ai-assist', classification: 'environment' }, // AI workflow instructions
  { id: 'automation', classification: 'environment' }, // team automation policy
  { id: 'shortcuts', classification: 'personal' },
  { id: 'remote', classification: 'environment' }, // the Environment's own device transport, pairing and relay
  { id: 'environments', classification: 'personal' }, // which environments THIS desktop connects to
  { id: 'mcp', classification: 'environment' }, // MCP servers
  { id: 'entra', classification: 'environment' }, // org identity, admin-scoped
] as const

/** `undefined` when `id` is not a known settings group -- not the same as "personal". */
export function classifySettingsGroup(id: string): SettingsClassification | undefined {
  return SETTINGS_GROUP_CLASSIFICATIONS.find((g) => g.id === id)?.classification
}

export const ENVIRONMENT_SETTINGS_GROUP_IDS: readonly string[] = SETTINGS_GROUP_CLASSIFICATIONS
  .filter((g) => g.classification === 'environment')
  .map((g) => g.id)

/**
 * Settings keys the Environment owns: one value for the whole server, held in
 * its `settings.json` and never in a per-identity overlay. Derived from the
 * settings registry, which is where a key's scope is declared.
 *
 * Only a connection holding the `admin` scope may write them, from any
 * transport. Who administers a server is an explicit grant, not a guess from
 * how the connection arrived: a paired device of the server's own operator
 * holds `admin` and manages it remotely, while a guest on the same transport
 * does not.
 */
export const ENVIRONMENT_OWNED_SETTINGS_KEYS: readonly string[] = settingKeysInScope('environment')

/**
 * The subset of environment-owned keys that only the server itself writes
 * (the pairing handler, revoke, the relay OIDC probe). A client's settings
 * document is a snapshot from whenever its store last loaded, so a save that
 * carried one of these would silently revert a fresh pairing on disk (an
 * iPhone once became "unknown device" on every reconnect for exactly this
 * reason). `settings.save` drops them from every patch; disk always wins.
 */
export const SERVER_OWNED_SETTINGS_KEYS: readonly string[] = ENVIRONMENT_OWNED_SETTINGS_KEYS.filter(isServerWrittenSettingKey)

export function isEnvironmentOwnedSettingsKey(key: string): boolean {
  return settingScope(key) === 'environment'
}

export function isServerOwnedSettingsKey(key: string): boolean {
  return isServerWrittenSettingKey(key)
}
