/**
 * The enterprise settings policy as this client applies it: which class a
 * setting is in, and the gate every preference write passes.
 *
 * A Personal or Device setting is under device policy, which is this
 * machine's own (the local Environment's `ion-desktop` namespace). An
 * Environment or Account setting is under the policy of the server that
 * stores it. The server and the main process refuse a sealed write on their
 * own; this gate keeps the client from showing a change that will not hold.
 */
import { useSyncExternalStore } from 'react'
import {
  resolveSettingMutability,
  sealedSettingsMessage,
  settingsPolicyNamespace,
  type SettingMutability,
} from '@ion/shared/enterprise-settings-policy'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { policyStore } from './studio/connection/policy-store'
import { rWarn } from './rendererLogger'

let devicePolicy: EnterprisePolicy | null = null
let notice: string | null = null
const listeners = new Set<() => void>()

function emit(): void { for (const listener of listeners) listener() }

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const offPolicy = policyStore.subscribe(listener)
  return () => { listeners.delete(listener); offPolicy() }
}

/**
 * Hold the local server's enterprise policy, which carries this machine's
 * device policy. Held here, not read from the policy store on each use: that
 * store forgets a server's policy while the server is unreachable, and a
 * device seal must not lift because of it.
 */
export function holdDevicePolicy(policy: EnterprisePolicy | null): void {
  devicePolicy = policy
  emit()
}

/** The class in force for `key`, for a write that would go to `environmentId`. */
export function settingMutability(key: string, environmentId: string = LOCAL_ENVIRONMENT_ID): SettingMutability {
  const namespace = settingsPolicyNamespace(key) ?? 'ion-server'
  // The held policy is the local server's whole policy, so it answers for
  // that server's own settings as well as for this device's.
  const local = namespace === 'ion-desktop' || environmentId === LOCAL_ENVIRONMENT_ID
  return resolveSettingMutability(local ? devicePolicy : policyStore.environmentPolicy(environmentId), key, namespace)
}

/**
 * `patch` without its sealed keys. A dropped key is logged and raises the
 * notice Settings shows, so a refused change is never a silent one.
 */
export function dropSealedSettings<T extends object>(patch: T, environmentId?: string): Partial<T> {
  const refused = Object.keys(patch).filter((key) => settingMutability(key, environmentId).class === 'sealed')
  if (refused.length === 0) return patch
  rWarn('preferences', 'setting change refused: sealed by enterprise policy', { keys: refused, class: 'sealed', environment_id: environmentId ?? LOCAL_ENVIRONMENT_ID })
  notice = sealedSettingsMessage(refused)
  emit()
  const allowed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!refused.includes(key)) allowed[key] = value
  }
  return allowed as Partial<T>
}

/** The last sealed-setting refusal, or null. */
export function useSettingsPolicyNotice(): string | null {
  return useSyncExternalStore(subscribe, () => notice)
}

export function clearSettingsPolicyNotice(): void {
  if (notice === null) return
  notice = null
  emit()
}

export const SEALED_SETTING_REASON = 'Set by your organization.'

let settingsTarget = LOCAL_ENVIRONMENT_ID

/** Record which server the Settings dialog is editing, so its rows lock by that server's policy. */
export function setSettingLockTarget(environmentId: string): void {
  if (settingsTarget === environmentId) return
  settingsTarget = environmentId
  emit()
}

/**
 * Why the control for `key` does not respond, or undefined when it does.
 * With no `environmentId`, the server Settings is editing decides.
 */
export function useSettingLock(key: string | undefined, environmentId?: string): string | undefined {
  return useSyncExternalStore(subscribe, () =>
    key !== undefined && settingMutability(key, environmentId ?? settingsTarget).class === 'sealed' ? SEALED_SETTING_REASON : undefined)
}

/**
 * The on/off value the policy fixes for `key`, or undefined when it fixes
 * none. A toggle shows this in place of the saved value, so it is right even
 * before the store has caught up with a policy that just arrived.
 */
export function useSealedToggleValue(key: string | undefined, environmentId?: string): boolean | undefined {
  return useSyncExternalStore(subscribe, () => {
    if (key === undefined) return undefined
    const mutability = settingMutability(key, environmentId ?? settingsTarget)
    return mutability.class === 'sealed' && mutability.hasValue && typeof mutability.value === 'boolean' ? mutability.value : undefined
  })
}

/** Test seam. */
export function _resetSettingsPolicyForTest(): void {
  devicePolicy = null
  notice = null
  settingsTarget = LOCAL_ENVIRONMENT_ID
}
