/**
 * policy-store — one enterprise policy snapshot per environment (spec 14):
 * `set`/`clear`/`devicePolicy`/`environmentPolicy`. Written from
 * `studio_welcome.enterprisePolicy` (every environment, on every
 * (re)connect) and `studio_environment_policy` (the server's push when the
 * policy changes after the welcome, such as after an engine reconnect); cleared when an
 * environment goes `offline` or `blocked` so a stale policy never survives a
 * connection loss.
 *
 * Device policy vs environment policy (spec 14 §Problem): the LOCAL
 * environment's `customFields['ion-desktop']` is the ONLY entry every
 * device-facing derivation (theme lock, active-UI lock, environment
 * catalog policy) may read — a remote server's enterprise
 * blob must never change what this device looks like or is allowed to do.
 * `set()` enforces this at the write boundary: a non-local environment's
 * `customFields['ion-desktop']` is stripped before the policy is stored, so
 * no downstream reader can accidentally pick it up even if it forgets to
 * call `devicePolicy()`.
 */
import type { EnterprisePolicy } from '@ion/shared/types-engine'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { EnvironmentPhase } from '@ion/shared/types-environments'
import { rWarn } from '../../rendererLogger'

/** Returns a copy of policy with customFields['ion-desktop'] removed (present only on the local entry). */
function stripIonDesktop(policy: EnterprisePolicy): EnterprisePolicy {
  if (!policy.customFields || !('ion-desktop' in policy.customFields)) return policy
  const { 'ion-desktop': _ionDesktop, ...rest } = policy.customFields
  return { ...policy, customFields: rest }
}

type Listener = () => void

class PolicyStore {
  private policies = new Map<string, EnterprisePolicy | null>()
  // Task 10 settings partition: unlike `policies`, this is NOT filtered by
  // the device-policy-vs-environment-policy rule above -- settingsHiddenGroups
  // is this CONNECTION's own entitlement for that environment (computed
  // server-side from conn.transport + that environment's own sealed config),
  // never a remote environment's opinion about this device.
  private hiddenGroups = new Map<string, string[]>()
  private listeners = new Set<Listener>()

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stores one environment's policy. Non-local `ion-desktop` custom fields are dropped with a WARN. */
  set(environmentId: string, policy: EnterprisePolicy | null): void {
    let stored = policy
    if (environmentId !== LOCAL_ENVIRONMENT_ID && policy?.customFields?.['ion-desktop']) {
      rWarn('studio.policy-store', 'remote ion-desktop custom fields ignored', { environment_id: environmentId })
      stored = stripIonDesktop(policy)
    }
    this.policies.set(environmentId, stored)
    this.notify()
  }

  /** Stores one environment's settingsHiddenGroups (from studio_welcome / studio_environment_policy). */
  setHiddenGroups(environmentId: string, groups: string[]): void {
    this.hiddenGroups.set(environmentId, groups)
    this.notify()
  }

  /** Clears one environment's policy (call on offline/blocked). */
  clear(environmentId: string): void {
    const hadPolicy = this.policies.delete(environmentId)
    const hadHiddenGroups = this.hiddenGroups.delete(environmentId)
    if (hadPolicy || hadHiddenGroups) this.notify()
  }

  /** Called by the registry on every phase transition: clears on offline/blocked, no-op otherwise. */
  onPhaseChange(environmentId: string, phase: EnvironmentPhase): void {
    if (phase === 'offline' || phase === 'blocked') this.clear(environmentId)
  }

  /** True while `environmentId` has an announced policy (a null one included); false once it is cleared. */
  has(environmentId: string): boolean {
    return this.policies.has(environmentId)
  }

  /** The LOCAL environment's policy only — the sole source for every device-facing derivation. */
  devicePolicy(): EnterprisePolicy | null {
    return this.policies.get(LOCAL_ENVIRONMENT_ID) ?? null
  }

  /**
   * The LOCAL environment's settingsHiddenGroups — SettingsDialog always
   * targets the local environment's engine/server (mutations dispatch as a
   * studio_action to LOCAL_ENVIRONMENT_ID regardless of which environment
   * Studio is currently viewing). Empty until the first `studio_welcome`.
   */
  deviceHiddenGroups(): string[] {
    return this.hiddenGroups.get(LOCAL_ENVIRONMENT_ID) ?? []
  }

  /** One environment's policy, or null when unknown/cleared. */
  environmentPolicy(environmentId: string): EnterprisePolicy | null {
    return this.policies.get(environmentId) ?? null
  }

  /** Test-only reset. */
  _resetForTest(): void {
    this.policies.clear()
    this.hiddenGroups.clear()
    this.listeners.clear()
  }
}

export const policyStore = new PolicyStore()
