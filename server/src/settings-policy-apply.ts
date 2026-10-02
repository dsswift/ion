/**
 * Puts this Environment's enterprise settings policy into effect, each time
 * the policy is read.
 *
 * Sealing is enforced where settings are read and written
 * (`persistence/sealed-settings.ts`, `protocol/settings-seal.ts`). What is
 * left for this module is everything that happens once per policy rather
 * than once per read or write:
 *
 *   - The applied state goes to `settings-policy-state.json` in the data
 *     directory, so a management system can read the class in force for
 *     every key, and the checksum of the policy that produced it, without a
 *     connection to this server. The same state answers `settings.policyState`.
 *   - A managed default is supplied. A `managed-default` key with a value is
 *     written once per value: the person may change it afterwards, and a
 *     policy that later carries a different value supplies that one. The
 *     record of what was supplied is `settings-policy-seeds.json`.
 *   - Connected clients are told about a value a seal brought in or took
 *     away, so nothing waits for a reload.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { managedDefaultSettingValues, stableStringify } from '@ion/shared/enterprise-settings-policy'
import { settingScope } from '@ion/shared/settings-registry'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import { broadcast } from './broadcast'
import { log as _log, warn as _warn } from './logger'
import { dataDir } from './paths'
import { sealedServerSettings } from './persistence/sealed-settings'
import { readSettings } from './persistence/settings-store'
import { listOverlays, readSettingsForSubject, replaceOverlay } from './persistence/user-settings-store'
import { isProjectableKey, validateSettingValue } from './projectable-settings'
import { broadcastDesktopSettingsSnapshot, persistAndBroadcastSettings } from './settings-broadcast'
import { settingsPolicyChecksum, settingsPolicyState, sha256, type SettingsPolicyState } from './settings-policy-state'
import { atomicWriteFileSync } from './utils/atomicWrite'

function log(msg: string, fields?: Record<string, unknown>): void { _log('settings-policy', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('settings-policy', msg, fields) }

export const SETTINGS_POLICY_STATE_FILENAME = 'settings-policy-state.json'
export const SETTINGS_POLICY_SEEDS_FILENAME = 'settings-policy-seeds.json'

function writeStateFile(state: SettingsPolicyState): void {
  const file = join(dataDir(), SETTINGS_POLICY_STATE_FILENAME)
  atomicWriteFileSync(file, JSON.stringify({ ...state, appliedAt: new Date().toISOString() }, null, 2), 0o644)
}

function readSeeds(): Record<string, string> {
  const file = join(dataDir(), SETTINGS_POLICY_SEEDS_FILENAME)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch (err) {
    // Read as empty: every managed default is supplied once more, which
    // restores the organization's value and leaves it changeable.
    warn('managed-default record unreadable; supplying every managed default again', { error: String(err) })
    return {}
  }
}

/** Supply each managed default whose value this data directory has not been given yet. Returns the keys written. */
function supplyManagedDefaults(policy: EnterprisePolicy | null): string[] {
  const wanted = managedDefaultSettingValues(policy, 'ion-server')
  const supplied = readSeeds()
  const next: Record<string, string> = {}
  const written: string[] = []
  for (const [key, value] of Object.entries(wanted)) {
    const signature = sha256(stableStringify(value))
    if (supplied[key] === signature) { next[key] = signature; continue }
    const invalid = isProjectableKey(key) ? validateSettingValue(key, value) : null
    if (invalid) {
      warn('managed default not supplied: the policy value is not valid for this setting', { key, error: invalid })
      continue
    }
    const current = readSettings()
    persistAndBroadcastSettings({ ...current, [key]: value }, current)
    if (settingScope(key) !== 'environment') {
      // An Account setting follows the Environment document until a person
      // sets their own. Clearing each person's value makes the new default
      // reach them; they may set it again.
      for (const overlay of listOverlays()) {
        if (!Object.prototype.hasOwnProperty.call(overlay.settings, key)) continue
        const { [key]: _dropped, ...rest } = overlay.settings
        replaceOverlay(overlay.subject, rest)
      }
    }
    broadcast('ion:settings-changed', key, value)
    next[key] = signature
    written.push(key)
    log('managed default supplied', { key, scope: settingScope(key) ?? 'unknown', resupplied: key in supplied })
  }
  if (stableStringify(next) !== stableStringify(supplied)) {
    atomicWriteFileSync(join(dataDir(), SETTINGS_POLICY_SEEDS_FILENAME), JSON.stringify(next, null, 2), 0o644)
  }
  return written
}

/** Tell connected clients the value in force for every key a seal brought in, changed, or took away. */
function announceSealedValues(policy: EnterprisePolicy | null, previous: EnterprisePolicy | null): string[] {
  const before = sealedServerSettings(previous)
  const after = sealedServerSettings(policy)
  const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => stableStringify(before[key]) !== stableStringify(after[key]) || (key in before) !== (key in after))
  if (moved.length === 0) return moved
  const environment = readSettings()
  for (const key of moved) {
    broadcast('ion:settings-changed', key, environment[key])
    if (settingScope(key) === 'environment') continue
    // A lifted seal uncovers each person's own value, which differs by person.
    for (const overlay of listOverlays()) {
      broadcast('ion:settings-changed', key, readSettingsForSubject(overlay.subject)[key], overlay.subject)
    }
  }
  return moved
}

let applied: { checksum: string; policy: EnterprisePolicy | null } | null = null

/**
 * Apply `policy`. Safe to call after every policy read: a policy whose
 * settings inputs are unchanged since the last call does nothing.
 */
export function applySettingsPolicy(policy: EnterprisePolicy | null, reason: string): void {
  const checksum = settingsPolicyChecksum(policy)
  if (applied?.checksum === checksum) {
    log('settings policy unchanged', { reason, checksum })
    return
  }
  const previous = applied?.policy ?? null
  const first = applied === null
  applied = { checksum, policy }
  const state = settingsPolicyState(policy)
  try {
    writeStateFile(state)
  } catch (err) {
    warn('settings policy state file not written', { error: String(err) })
  }
  let supplied: string[] = []
  try {
    supplied = supplyManagedDefaults(policy)
  } catch (err) {
    warn('managed defaults not supplied', { error: String(err) })
  }
  const announced = first ? [] : announceSealedValues(policy, previous)
  // The projected schema marks each sealed key, so a thin client's list is
  // stale as soon as the classes move.
  if (!first) broadcastDesktopSettingsSnapshot('settings-policy')
  const classes = Object.values(state.keys)
  log('settings policy applied', {
    reason,
    checksum,
    server_default: state.namespaces['ion-server']?.defaultClass ?? null,
    desktop_default: state.namespaces['ion-desktop']?.defaultClass ?? null,
    sealed: classes.filter((k) => k.class === 'sealed').length,
    managed_default: classes.filter((k) => k.class === 'managed-default').length,
    user_adjustable: classes.filter((k) => k.class === 'user-adjustable').length,
    ignored_keys: state.ignoredKeys,
    supplied,
    announced,
  })
}

/** Test seam. */
export function _resetSettingsPolicyApplyForTest(): void {
  applied = null
}
