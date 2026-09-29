/**
 * The desktop's enterprise environment policy: which servers this desktop may
 * add to its own catalog, from `customFields['ion-desktop'].environmentPolicy`.
 * Device policy, so it governs this machine only and never reaches another
 * client.
 */
import type { EnterprisePolicy, IonDesktopPolicyFields } from './types-engine'

/**
 * `local-only`: only the local environment may exist in the catalog (managed
 * entries are still listed, but blocked from connecting).
 * `allowlist`: an addition must match `allowed[]` when `locked`; otherwise
 * `allowed[]` is a managed DEFAULT the user may override.
 * `central-only`: the local environment is hidden from pickers/views and a
 * local draft is refused; the local server still runs underneath.
 */
export type DesktopEnvironmentPolicyMode = 'local-only' | 'allowlist' | 'central-only'

export interface DesktopEnvironmentPolicy {
  mode: DesktopEnvironmentPolicyMode
  allowed: string[]
  locked: boolean
}

/**
 * The desktop catalog's enforcement shape (spec 14, manifest C11):
 * `{ mode, allowed, locked }`. A missing or malformed shape is the least
 * restrictive `allowlist` with an empty allowlist and no lock: never invent
 * an enforcement the operator did not actually configure.
 */
export function deriveDesktopEnvironmentPolicy(
  policy: EnterprisePolicy | null | undefined,
): DesktopEnvironmentPolicy {
  const fields = (policy?.customFields?.['ion-desktop'] ?? {}) as IonDesktopPolicyFields
  const raw = fields.environmentPolicy && typeof fields.environmentPolicy === 'object' ? fields.environmentPolicy : null
  const mode = raw?.mode === 'local-only' || raw?.mode === 'central-only' || raw?.mode === 'allowlist'
    ? raw.mode
    : 'allowlist'
  const allowed = Array.isArray(raw?.allowed) ? raw.allowed.filter((v): v is string => typeof v === 'string') : []
  const locked = raw?.locked === true
  return { mode, allowed, locked }
}
