/**
 * Pure derivation of the enterprise Tab Strip policy from the enterprise blob.
 *
 * Shared between the main process and the renderer so both surfaces validate
 * the MDM-supplied shape identically, exactly as the theme policy does.
 *
 * Semantics, mirroring `themePolicy`:
 *   - `visible` alone (locked absent/false): managed DEFAULT — applied when
 *     the user has never chosen for themselves; they may change it
 *     afterwards and their choice survives every later launch.
 *   - `locked: true`: enforced — the value always applies and the Settings
 *     toggle is disabled.
 *
 * Studio only. The Overlay is a compact surface whose Tab Strip is the only
 * way to switch conversations in it, so it always keeps one
 * (`settings-store.ts`, `studioTabStripVisible`).
 */
import type { EnterprisePolicy, IonDesktopPolicyFields } from './types-engine'

export interface EnterpriseTabStripPolicy {
  /** Whether the Studio Tab Strip is shown. */
  visible: boolean
  /** When true the user cannot change it and the Settings toggle is disabled. */
  locked: boolean
}

export function deriveEnterpriseTabStripPolicy(
  policy: EnterprisePolicy | null | undefined,
): EnterpriseTabStripPolicy | null {
  const fields = (policy?.customFields?.['ion-desktop'] ?? {}) as IonDesktopPolicyFields
  const raw = fields.tabStripPolicy
  if (!raw || typeof raw !== 'object') return null
  // `visible` is the whole point of the policy: a block without it says
  // nothing, and defaulting it either way would invent an opinion the
  // operator did not express.
  if (typeof raw.visible !== 'boolean') return null
  return { visible: raw.visible, locked: raw.locked === true }
}
