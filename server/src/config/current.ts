/**
 * The process-wide loaded `server.json` (`config/server-config.ts`), set once
 * at boot by `main.ts` and read by anything that needs a config value outside
 * the boot function's own scope -- most notably `auth/actions.ts`'s
 * `auth.createPairingChannel`, which needs to look up a relay's configured
 * PSK by URL. Mirrors the `connectionRegistry`/`engineBridge` "process-wide
 * singleton" pattern already used elsewhere in this package rather than
 * threading a config object through every call site.
 */
import { defaultServerConfig, unownedTabsDefault, type ServerConfig } from './server-config'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('server-config', msg, fields)
}

let current: ServerConfig = defaultServerConfig()

export function setCurrentServerConfig(config: ServerConfig): void {
  current = config
}

export function currentServerConfig(): ServerConfig {
  return current
}

/**
 * True when this server can authenticate more than one distinct external
 * identity at once. `oidc` presence is the only existing signal for that: a
 * `local` credential is always the same-machine trusted owner and a `paired`
 * credential is that owner's own remote device -- neither introduces a second
 * principal. `bearer`/`session` credentials (the only doors that produce an
 * OIDC-issued principal) are refused unconditionally when `oidc` is null
 * (`auth/auth-policy.ts`), so "oidc configured" and "more than one principal
 * is possible" are the same fact.
 */
export function isMultiTenant(): boolean {
  return current.oidc !== null
}

/**
 * A3 (gap-report fail-closed fix): whether an UNRESOLVABLE tab-ownership
 * lookup -- a legacy pre-backfill record, a corrupt `tabs.json` -- should
 * still be treated as everyone's (`true`) or no one's (`false`). Reads the
 * explicit `server.json.tenancy.unownedTabs` override
 * (`config/server-config.ts`'s `ServerTenancyConfig`) when the operator set
 * one, otherwise derives the default LIVE from the current `oidc` via
 * `unownedTabsDefault` -- never resolved once and frozen, so a config swap
 * that changes `oidc` (a reload, a test fixture) changes this policy too
 * without also requiring `tenancy` to be touched. Consulted by every
 * fail-open-turned-fail-closed site: `protocol/tabs-index.ts`,
 * `protocol/events.ts`, `protocol/actions.ts`, `protocol/mirror-projection.ts`,
 * `remote/snapshot.ts`.
 */
export function unownedTabsVisible(): boolean {
  return (current.tenancy.unownedTabs ?? unownedTabsDefault(current.oidc)) === 'visible'
}

/**
 * FR-02: true when `server.json.tenancy.mode` is explicitly `'shared'`.
 * Defaults to `false` (isolated) -- the historical single-owner-desktop
 * behavior every filter below already implements today. When true, every
 * per-principal tab filter (`tabVisibleTo`, `filterBySubject`,
 * `mirror-projection.ts`'s `ownsTab` (A1), `protocol/actions.ts`'s
 * `connOwnsTab`/`connOwnsConversation` (A2/A2b)) falls through to
 * "visible/owned by everyone" instead of checking `principalSubject`.
 *
 * Unlike `unownedTabsVisible()`, this has no derived default from `oidc`:
 * shared tenancy is an explicit administrative choice, never inferred.
 */
export function isSharedTenancy(): boolean {
  if (current.tenancy.mode) return current.tenancy.mode === 'shared'
  // No explicit mode: the install profile's default applies -- unless the
  // engine partitions storage per principal, which a shared view would
  // contradict. An explicit `shared` with partitioning is a conflict the
  // server refuses to start on (main.ts); a DEFAULT simply steps back.
  return current.tenancyDefault === 'shared' && !enginePartitionsPrincipals
}

/** True when `server.json` itself sets `tenancy.mode: shared` (as opposed to the install profile's default). */
export function sharedTenancyIsExplicit(): boolean {
  return current.tenancy.mode === 'shared'
}

let enginePartitionsPrincipals = false

/** Records what the connected engine reports for `principalPartitioning.enabled`. */
export function noteEnginePrincipalPartitioning(enabled: boolean): void {
  if (enabled !== enginePartitionsPrincipals) log('engine principal partitioning noted', { enabled, tenancy_default: current.tenancyDefault, explicit_mode: current.tenancy.mode ?? '' })
  enginePartitionsPrincipals = enabled
}

/** TEST ONLY. Resets to the built-in defaults between test cases. */
export function _resetCurrentServerConfigForTest(): void {
  current = defaultServerConfig()
  enginePartitionsPrincipals = false
}
