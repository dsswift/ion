/**
 * The values this Environment's enterprise settings policy fixes, laid over
 * what is stored.
 *
 * A sealed setting with a policy value reads as that value everywhere, and
 * the stored value is left alone underneath, so it is back the moment the
 * seal lifts. A sealed setting, with a policy value or without, does not
 * change on disk. Both halves happen at the persistence layer: every read of
 * the settings document passes `withSealedSettings`, and every write of it
 * passes `keepStoredUnderSeal`, which puts the stored value back before the
 * document reaches disk.
 *
 * Only the server's own namespace applies here. A device-policy seal is the
 * local desktop's, and is applied per connection where the key is served.
 */
import { governedSettingKeys, resolveSettingMutability, sealedSettingValues } from '@ion/shared/enterprise-settings-policy'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import { currentEnterprisePolicy } from '../enterprise-policy-source'

interface Sealed {
  /** Every server-stored key the policy seals. */
  keys: string[]
  /** The sealed keys the policy supplies a value for, with that value. */
  values: Record<string, unknown>
}

const NONE: Sealed = { keys: [], values: {} }
const cache = new WeakMap<EnterprisePolicy, Sealed>()

/** Resolved once per policy object: a new policy is a new object. */
function sealed(policy: EnterprisePolicy | null): Sealed {
  if (!policy) return NONE
  let resolved = cache.get(policy)
  if (!resolved) {
    const keys = governedSettingKeys(policy, 'ion-server').filter((key) => resolveSettingMutability(policy, key, 'ion-server').class === 'sealed')
    resolved = { keys, values: sealedSettingValues(policy, 'ion-server') }
    cache.set(policy, resolved)
  }
  return resolved
}

/** The server-stored keys the policy fixes to a value, with their values. */
export function sealedServerSettings(policy: EnterprisePolicy | null = currentEnterprisePolicy()): Record<string, unknown> {
  return sealed(policy).values
}

/** True when the policy seals at least one server-stored key. */
export function hasSealedSettings(): boolean {
  return sealed(currentEnterprisePolicy()).keys.length > 0
}

/** `document` as it reads under the policy: every sealed value in place. */
export function withSealedSettings<T extends Record<string, unknown>>(document: T): T {
  const values = sealedServerSettings()
  return Object.keys(values).length === 0 ? document : { ...document, ...values }
}

/**
 * `next` as it may reach disk: every sealed key carries what `stored` holds,
 * never the policy's value and never a new one. This is the seal on every
 * writer, including the ones that never pass a refusal gate. Returns the keys
 * it put back.
 */
export function keepStoredUnderSeal(next: Record<string, unknown>, stored: Record<string, unknown>): string[] {
  const restored: string[] = []
  for (const key of sealed(currentEnterprisePolicy()).keys) {
    const has = Object.prototype.hasOwnProperty.call(stored, key)
    if (has ? JSON.stringify(next[key]) === JSON.stringify(stored[key]) : !Object.prototype.hasOwnProperty.call(next, key)) continue
    if (has) next[key] = stored[key]
    else delete next[key]
    restored.push(key)
  }
  return restored
}
