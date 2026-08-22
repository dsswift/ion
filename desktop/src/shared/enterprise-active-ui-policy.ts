/**
 * Pure derivation of the enterprise active-UI policy from the enterprise
 * blob (modeled on enterprise-theme-policy.ts — one validator shared by
 * the main process and the renderer so both surfaces read the MDM shape
 * identically).
 *
 * Semantics:
 *   - `ui` alone (locked absent/false): managed DEFAULT — the resolver
 *     uses it when the user has no explicit preference; the user may
 *     still switch.
 *   - `locked: true`: enforced — the resolver clamps to `ui`, the picker
 *     is disabled, and `persistAndBroadcastSettings()` strips activeUi
 *     writes at the single settings funnel.
 */
import type { EnterprisePolicy, IonDesktopPolicyFields } from './types-engine'

export type ActiveUi = 'overlay' | 'studio'

export interface EnterpriseActiveUiPolicy {
  ui: ActiveUi
  locked: boolean
}

export function deriveEnterpriseActiveUiPolicy(
  policy: EnterprisePolicy | null | undefined,
): EnterpriseActiveUiPolicy | null {
  const fields = (policy?.customFields?.['ion-desktop'] ?? {}) as IonDesktopPolicyFields
  const raw = fields.activeUiPolicy
  if (!raw || typeof raw !== 'object') return null
  if (raw.ui !== 'overlay' && raw.ui !== 'studio') return null
  return { ui: raw.ui, locked: raw.locked === true }
}
