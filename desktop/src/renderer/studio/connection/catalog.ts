/**
 * catalog — the persisted `EnvironmentTarget[]` in `desktop.json`, plus
 * managed entries the local device policy contributes (spec 13). This
 * module owns the write funnel: every addition, edit, and removal passes
 * through here so the environment-policy enforcement (child 14) has one
 * seam to guard.
 *
 * The always-present local environment is never an entry in this list — it
 * is synthesized by `registry.ts` under the reserved id `LOCAL_ENVIRONMENT_ID`.
 */
import type { EnvironmentCatalogEntry, EnvironmentTarget } from '@ion/shared/types-environments'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { deriveDesktopEnvironmentPolicy, type DesktopEnvironmentPolicy } from '@ion/shared/enterprise-environment-policy'
import { host } from '../../host/host-instance'
import { policyStore } from './policy-store'
import { LOCAL_ENVIRONMENT_LABEL } from './local-label'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

/** Stable id for a non-local catalog entry: its welcomed environmentId, or an index fallback before one is known. */
function catalogEntryId(target: EnvironmentTarget, index: number): string {
  if (target.kind !== 'local' && target.environmentId) return target.environmentId
  return `catalog-${index}`
}

function labelOf(target: EnvironmentTarget): string {
  return target.kind === 'local' ? LOCAL_ENVIRONMENT_LABEL : target.label
}

/**
 * Refusal for an addition the environment policy does not allow (spec 14
 * phase 2): `local-only` blocks every non-local addition; `allowlist`
 * blocks an addition outside `allowed[]` ONLY when `locked` (unlocked is a
 * managed default, not enforcement, so the user may still add anything);
 * `central-only` has no bearing on adding a REMOTE environment (it only
 * hides/refuses the LOCAL one, enforced by the view filter and draft lock,
 * not here).
 */
function policyRefusal(target: EnvironmentTarget, policy: DesktopEnvironmentPolicy): string | null {
  if (target.kind === 'local') return null
  if (policy.mode === 'local-only') {
    return 'policy_disallowed: this device is restricted to its local environment only'
  }
  if (policy.mode === 'allowlist' && policy.locked && !policy.allowed.includes(target.url)) {
    return `policy_disallowed: ${target.url} is not on the enterprise allowlist`
  }
  return null
}

/**
 * Reads the full catalog (local first, then every persisted entry) from
 * `desktop.json`. A browser Studio client (spec 18) has exactly one
 * reachable environment — the server that served the page — and no catalog
 * to persist additions to, so it short-circuits to a single synthesized
 * entry under the SAME reserved `LOCAL_ENVIRONMENT_ID` the desktop uses for
 * its own always-present local environment. Reusing `{kind:'local'}` here
 * (rather than a literal `{kind:'bearer', url:origin}` target) is
 * deliberate: `registry.ts`'s `attempt()` exempts `target.kind === 'local'`
 * from the desktop environment policy (local-only/allowlist) — a `bearer`
 * target would be wrongly policy-checked against a restriction that makes
 * no sense for a client that has no other environment it could possibly
 * reach.
 */
export async function readCatalog(): Promise<EnvironmentCatalogEntry[]> {
  if (!host.capabilities().includes('local')) {
    return [{ id: LOCAL_ENVIRONMENT_ID, label: 'This Server', target: { kind: 'local' } }]
  }
  const settings = await host.deviceSettings()
  const targets = Array.isArray(settings.environments) ? (settings.environments as EnvironmentTarget[]) : []
  const entries: EnvironmentCatalogEntry[] = [{ id: LOCAL_ENVIRONMENT_ID, label: LOCAL_ENVIRONMENT_LABEL, target: { kind: 'local' } }]
  targets.forEach((target, index) => {
    entries.push({ id: catalogEntryId(target, index), label: labelOf(target), target })
  })
  return entries
}

const catalogListeners = new Set<() => void>()

/**
 * Subscribes to catalog writes. Every mutation in this module passes through
 * `writeTargets`, so a listener hears every addition, relabel, removal, and
 * managed reconcile. Returns the unsubscribe.
 */
export function onCatalogChange(listener: () => void): () => void {
  catalogListeners.add(listener)
  return () => { catalogListeners.delete(listener) }
}

async function writeTargets(targets: EnvironmentTarget[]): Promise<void> {
  await host.setDeviceSetting('environments', targets)
  rDebug('studio.catalog', 'catalog written; notifying listeners', { targets: targets.length, listeners: catalogListeners.size })
  for (const listener of [...catalogListeners]) listener()
}

/**
 * Adds one non-local target to the catalog. Returns the persisted list.
 * Refuses (throws) when the device's environment policy disallows the
 * addition (spec 14 phase 2) — the caller (Settings UI / add-environment
 * flow) surfaces the refusal rather than the write silently no-op'ing.
 */
export async function addToCatalog(target: EnvironmentTarget): Promise<EnvironmentTarget[]> {
  const policy = deriveDesktopEnvironmentPolicy(policyStore.devicePolicy())
  const refusal = policyRefusal(target, policy)
  if (refusal) {
    rWarn('studio.catalog', 'addToCatalog refused by environment policy', { kind: target.kind, mode: policy.mode, reason: refusal })
    throw new Error(refusal)
  }
  const settings = await host.deviceSettings()
  const existing = Array.isArray(settings.environments) ? (settings.environments as EnvironmentTarget[]) : []
  const next = [...existing, target]
  await writeTargets(next)
  rInfo('studio.catalog', 'environment added', { kind: target.kind, label: target.kind !== 'local' ? target.label : undefined })
  return next
}

/** Renames a catalog entry's label. No-op for the local entry (it has no persisted label). */
export async function relabelCatalogEntry(index: number, label: string): Promise<EnvironmentTarget[]> {
  const settings = await host.deviceSettings()
  const existing = Array.isArray(settings.environments) ? (settings.environments as EnvironmentTarget[]) : []
  const target = existing[index]
  if (!target || target.kind === 'local') {
    rWarn('studio.catalog', 'relabel requested for a missing or local entry', { index })
    return existing
  }
  const next = existing.slice()
  next[index] = { ...target, label }
  await writeTargets(next)
  rDebug('studio.catalog', 'environment relabeled', { index, label })
  return next
}

/**
 * Removes a catalog entry by index. Refuses when the entry is `managed`
 * (spec 13: "managed entries cannot be removed while the policy lists
 * them") — the caller (Settings UI) is expected to show why instead of
 * silently no-op'ing, so this throws rather than swallowing the refusal.
 */
export async function removeFromCatalog(index: number): Promise<EnvironmentTarget[]> {
  const settings = await host.deviceSettings()
  const existing = Array.isArray(settings.environments) ? (settings.environments as EnvironmentTarget[]) : []
  const target = existing[index]
  if (!target) {
    rWarn('studio.catalog', 'remove requested for a missing entry', { index })
    return existing
  }
  if (target.kind !== 'local' && target.managed) {
    throw new Error('managed entries cannot be removed while the policy lists them')
  }
  const next = existing.filter((_, i) => i !== index)
  await writeTargets(next)
  rInfo('studio.catalog', 'environment removed', { index })
  return next
}

/**
 * Reconciles the catalog's managed entries against the device policy's
 * `environments[]` list (spec 13/14): added entries not already present
 * (matched by `url`) are appended with `managed: true`; a managed entry
 * whose url disappeared from the list is retired (no reconnect forced —
 * an already-connected environment simply becomes removable, per spec 13's
 * edge case).
 */
export async function reconcileManagedCatalog(policyEntries: EnvironmentTarget[]): Promise<EnvironmentTarget[]> {
  const settings = await host.deviceSettings()
  const existing = Array.isArray(settings.environments) ? (settings.environments as EnvironmentTarget[]) : []
  const existingUrls = new Set(existing.filter((t) => t.kind !== 'local').map((t) => (t as { url: string }).url))
  const policyUrls = new Set(policyEntries.filter((t) => t.kind !== 'local').map((t) => (t as { url: string }).url))
  const kept = existing.filter((t) => t.kind === 'local' || !t.managed || policyUrls.has((t as { url: string }).url))
  const additions = policyEntries.filter((t) => t.kind !== 'local' && !existingUrls.has((t as { url: string }).url))
  const next = [...kept, ...additions.map((t) => ({ ...t, managed: true }))]
  if (next.length === existing.length && additions.length === 0) return existing
  await writeTargets(next)
  rInfo('studio.catalog', 'managed catalog reconciled', { added: additions.length, kept: kept.length })
  return next
}
