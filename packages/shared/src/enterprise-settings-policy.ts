/**
 * Enterprise settings policy: one resolver from a settings key to its
 * mutability class.
 *
 * An organization classifies settings in a `settingsPolicy` block:
 *
 *   { "defaultClass": "sealed",
 *     "keys": { "selectedTheme": { "class": "user-adjustable" },
 *               "gitOpsMode":    { "class": "sealed", "value": "worktree" } } }
 *
 * Three classes:
 *
 *   user-adjustable   The person sets it freely.
 *   managed-default   The policy supplies a value; the person may change it.
 *                     A new policy value is supplied again.
 *   sealed            The policy fixes the value; a write is refused. With no
 *                     `value`, the value in force when the seal applied stays.
 *
 * The block lives in the namespace of whoever stores the key, because that
 * is who can enforce it (the settings registry names each key's scope):
 *
 *   customFields['ion-server']   Environment and Account settings. The server
 *                                holds them and enforces the class for every
 *                                connection.
 *   customFields['ion-desktop']  Personal and Device settings. Device policy:
 *                                it governs the desktop it is installed on,
 *                                and never a client visiting from elsewhere.
 *
 * A key named in the wrong namespace is not enforced; `describeSettingsPolicy`
 * lists it under `ignoredKeys`.
 *
 * `defaultClass` decides every registered setting the block does not name,
 * except the keys the registry marks `recorded` (the app's own bookkeeping).
 * With no block, every key is user-adjustable.
 *
 * Anything malformed fails closed: an unknown class, or an entry that is not
 * an object, reads as sealed.
 *
 * The two settings that had their own policy blocks before this one resolve
 * through here too: `themePolicy` classifies `selectedTheme`, and
 * `agentSettingsEdits` classifies `allowSettingsEdits`. A `settingsPolicy`
 * entry naming the key outranks the older block.
 */
import type { EnterprisePolicy } from './types-enterprise'
import { deriveEnterpriseSettingsEditsPolicy } from './enterprise-settings-edits-policy'
import {
  SETTINGS_REGISTRY,
  isRecordedSettingKey,
  isServerWrittenSettingKey,
  isSettingKey,
  settingScope,
} from './settings-registry'

export const SETTING_MUTABILITY_CLASSES = ['user-adjustable', 'managed-default', 'sealed'] as const
export type SettingMutabilityClass = (typeof SETTING_MUTABILITY_CLASSES)[number]

export const SETTINGS_POLICY_NAMESPACES = ['ion-server', 'ion-desktop'] as const
export type SettingsPolicyNamespace = (typeof SETTINGS_POLICY_NAMESPACES)[number]

/** One key's entry in a `settingsPolicy` block, as an administrator writes it. */
export interface SettingsPolicyKeyFields {
  class: SettingMutabilityClass
  value?: unknown
}

/** A `settingsPolicy` block, as an administrator writes it. */
export interface SettingsPolicyFields {
  /** The administrator's own label for this revision. Reported back, never interpreted. */
  version?: string
  defaultClass?: SettingMutabilityClass
  keys?: Record<string, SettingsPolicyKeyFields>
}

/** Where a key's class came from. */
export type SettingMutabilitySource = 'key' | 'themePolicy' | 'agentSettingsEdits' | 'default' | 'none'

export interface SettingMutability {
  class: SettingMutabilityClass
  /** True when the policy supplies the value. */
  hasValue: boolean
  value?: unknown
  source: SettingMutabilitySource
}

interface ParsedEntry {
  class: SettingMutabilityClass
  hasValue: boolean
  value?: unknown
}

interface ParsedBlock {
  version: string | null
  defaultClass: SettingMutabilityClass
  keys: Record<string, ParsedEntry>
}

const UNGOVERNED: SettingMutability = { class: 'user-adjustable', hasValue: false, source: 'none' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMutabilityClass(value: unknown): value is SettingMutabilityClass {
  return typeof value === 'string' && (SETTING_MUTABILITY_CLASSES as readonly string[]).includes(value)
}

function parseEntry(raw: unknown): ParsedEntry {
  if (!isRecord(raw) || !isMutabilityClass(raw.class)) return { class: 'sealed', hasValue: false }
  const hasValue = Object.prototype.hasOwnProperty.call(raw, 'value') && raw.value !== undefined
  return hasValue ? { class: raw.class, hasValue, value: raw.value } : { class: raw.class, hasValue }
}

function parseBlock(policy: EnterprisePolicy | null | undefined, namespace: SettingsPolicyNamespace): ParsedBlock | null {
  const fields = policy?.customFields?.[namespace]
  const raw = isRecord(fields) ? fields.settingsPolicy : undefined
  if (!isRecord(raw)) return null
  const keys: Record<string, ParsedEntry> = {}
  if (isRecord(raw.keys)) {
    for (const [key, entry] of Object.entries(raw.keys)) keys[key] = parseEntry(entry)
  }
  const defaultClass: SettingMutabilityClass =
    raw.defaultClass === undefined ? 'user-adjustable' : isMutabilityClass(raw.defaultClass) ? raw.defaultClass : 'sealed'
  return { version: typeof raw.version === 'string' && raw.version ? raw.version : null, defaultClass, keys }
}

/** The namespace whose block governs `key`; `undefined` for a key the registry does not know. */
export function settingsPolicyNamespace(key: string): SettingsPolicyNamespace | undefined {
  const scope = settingScope(key)
  if (scope === 'environment' || scope === 'account') return 'ion-server'
  if (scope === 'personal' || scope === 'device') return 'ion-desktop'
  return undefined
}

/** False for a key no policy can classify: a runtime value, or one only the server itself writes. */
function isGovernable(key: string): boolean {
  return !(settingScope(key) === 'runtime' || isServerWrittenSettingKey(key))
}

/** The older `themePolicy` block as a class for `selectedTheme`, or null. */
function themePolicyMutability(policy: EnterprisePolicy | null | undefined): SettingMutability | null {
  const fields = policy?.customFields?.['ion-desktop']
  const raw = isRecord(fields) ? fields.themePolicy : undefined
  if (!isRecord(raw) || typeof raw.themeId !== 'string' || raw.themeId.length === 0) return null
  return { class: raw.locked === true ? 'sealed' : 'managed-default', hasValue: true, value: raw.themeId, source: 'themePolicy' }
}

/**
 * The class in force for `key`.
 *
 * `storedBy` names the namespace for a key the registry does not know: the
 * side that stores it. A registered key ignores it.
 */
export function resolveSettingMutability(
  policy: EnterprisePolicy | null | undefined,
  key: string,
  storedBy?: SettingsPolicyNamespace,
): SettingMutability {
  if (!policy || !isGovernable(key)) return UNGOVERNED
  const namespace = settingsPolicyNamespace(key) ?? storedBy
  if (!namespace) return UNGOVERNED
  const block = parseBlock(policy, namespace)
  const entry = block && Object.prototype.hasOwnProperty.call(block.keys, key) ? block.keys[key] : undefined
  if (entry) return { ...entry, source: 'key' }
  if (key === 'selectedTheme') {
    const theme = themePolicyMutability(policy)
    if (theme) return theme
  }
  if (key === 'allowSettingsEdits') {
    const seal = deriveEnterpriseSettingsEditsPolicy(policy)
    if (seal) return { class: 'sealed', hasValue: true, value: seal.allowed, source: 'agentSettingsEdits' }
  }
  if (block && block.defaultClass !== 'user-adjustable' && isSettingKey(key) && !isRecordedSettingKey(key)) {
    return { class: block.defaultClass, hasValue: false, source: 'default' }
  }
  return UNGOVERNED
}

/** Every key `namespace` can classify: its registered settings, plus any other key its block names. */
export function governedSettingKeys(policy: EnterprisePolicy | null | undefined, namespace: SettingsPolicyNamespace): string[] {
  const keys = new Set<string>()
  for (const key of Object.keys(SETTINGS_REGISTRY)) {
    if (settingsPolicyNamespace(key) === namespace && isGovernable(key)) keys.add(key)
  }
  for (const key of Object.keys(parseBlock(policy, namespace)?.keys ?? {})) {
    if (!isSettingKey(key)) keys.add(key)
  }
  return [...keys].sort()
}

/** The keys of `namespace` whose value the policy fixes, with that value. */
export function sealedSettingValues(policy: EnterprisePolicy | null | undefined, namespace: SettingsPolicyNamespace): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!policy) return out
  for (const key of governedSettingKeys(policy, namespace)) {
    const mutability = resolveSettingMutability(policy, key, namespace)
    if (mutability.class === 'sealed' && mutability.hasValue) out[key] = mutability.value
  }
  return out
}

/** The keys of `namespace` the policy supplies a changeable value for, with that value. */
export function managedDefaultSettingValues(policy: EnterprisePolicy | null | undefined, namespace: SettingsPolicyNamespace): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!policy) return out
  for (const key of governedSettingKeys(policy, namespace)) {
    const mutability = resolveSettingMutability(policy, key, namespace)
    // The older theme block keeps its own apply-once rule; only a
    // `settingsPolicy` entry is supplied through this path.
    if (mutability.class === 'managed-default' && mutability.hasValue && mutability.source === 'key') out[key] = mutability.value
  }
  return out
}

export interface SettingsPolicyKeyState {
  class: SettingMutabilityClass
  source: SettingMutabilitySource
  namespace: SettingsPolicyNamespace
}

/**
 * The applied class of every governable key. Classes and where they came
 * from only: no setting's value, the policy's or a person's, is in it.
 */
export interface SettingsPolicyDescription {
  namespaces: Record<SettingsPolicyNamespace, { version: string | null; defaultClass: SettingMutabilityClass } | null>
  keys: Record<string, SettingsPolicyKeyState>
  /** Keys a block names that it cannot govern: stored by the other namespace, or not governable at all. */
  ignoredKeys: string[]
}

export function describeSettingsPolicy(
  policy: EnterprisePolicy | null | undefined,
  namespaces: readonly SettingsPolicyNamespace[] = SETTINGS_POLICY_NAMESPACES,
): SettingsPolicyDescription {
  const description: SettingsPolicyDescription = { namespaces: { 'ion-server': null, 'ion-desktop': null }, keys: {}, ignoredKeys: [] }
  const ignored = new Set<string>()
  for (const namespace of namespaces) {
    const block = parseBlock(policy, namespace)
    description.namespaces[namespace] = block ? { version: block.version, defaultClass: block.defaultClass } : null
    for (const key of governedSettingKeys(policy, namespace)) {
      const { class: mutabilityClass, source } = resolveSettingMutability(policy, key, namespace)
      description.keys[key] = { class: mutabilityClass, source, namespace }
    }
    for (const key of Object.keys(block?.keys ?? {})) {
      if (!isGovernable(key) || (isSettingKey(key) && settingsPolicyNamespace(key) !== namespace)) ignored.add(key)
    }
  }
  description.ignoredKeys = [...ignored].sort()
  return description
}

/**
 * The policy inputs every class is resolved from, in a stable order, for a
 * checksum. Two policies with the same fingerprint resolve identically.
 */
export function settingsPolicyFingerprint(policy: EnterprisePolicy | null | undefined): string {
  const server = policy?.customFields?.['ion-server']
  const desktop = policy?.customFields?.['ion-desktop']
  return stableStringify({
    'ion-server': isRecord(server) ? { settingsPolicy: server.settingsPolicy ?? null, agentSettingsEdits: server.agentSettingsEdits ?? null } : null,
    'ion-desktop': isRecord(desktop) ? { settingsPolicy: desktop.settingsPolicy ?? null, themePolicy: desktop.themePolicy ?? null } : null,
  })
}

/** JSON with object keys sorted at every depth, so equal values always serialize alike. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What a refused write of sealed keys says, on every surface. */
export function sealedSettingsMessage(keys: readonly string[]): string {
  return `${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} sealed by your organization and cannot be changed here`
}

/** The answer to a request to write one Device setting: done, or refused under a seal. */
export type DeviceSettingWrite =
  | { ok: true }
  | { ok: false; code: 'settings_sealed'; key: string; class: 'sealed'; message: string }
