/**
 * `provider.*` / `model.*` `studio_action`s — the wire face of
 * `engine/provider-api.ts`.
 *
 * A third registry alongside `auth/actions.ts`'s `AUTH_ACTIONS` and
 * `transfer/actions.ts`'s `TRANSFER_ACTIONS`, checked by
 * `protocol/actions.ts#handleAction` before the store-action fallthrough.
 * Like those, none of these has a session-store equivalent and so none has a
 * desktop-mirror classification to make: they are server-owned engine
 * configuration, not conversation state.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Reads are `conversations:read`: a client that may see conversations must
 * be able to render a model picker, which needs the model and provider
 * lists. Writes are `admin`, because they change the configuration of a
 * SHARED engine — storing a credential or repointing the default provider
 * affects every other client of the same Environment, not just the caller.
 * A `Studio.User` can therefore pick a model to run with; only a
 * `Studio.Admin` can change what the server is configured to reach.
 */
import type { Scope, StudioActionError } from '@ion/shared/studio-wire/types'
import * as providerApi from '../engine/provider-api'
import { getProviderSubscription, refreshProviderSubscription, selectProviderSubscription } from '../engine/provider-subscription-api'
import { readPlanBashAllowlist, writePlanBashAllowlist } from '../plan-bash-allowlist-store'
import { ManagedEngineConfigError } from '../persistence/settings-store'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'
import { connectionOnHost } from './hello'
import { currentEnterprisePolicy } from '../enterprise-policy-source'
import { sealRefusalError, settingsSealRefusal } from './settings-seal'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('provider-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('provider-actions', msg, fields)
}

export type ProviderActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: StudioActionError }

export interface ProviderActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<ProviderActionOutcome>
}

/** Wrap a provider-api call so a throw becomes a typed action error, never a dropped reply. */
function wrap(
  name: string,
  requiredScope: Scope,
  run: (args: unknown[], conn: Connection) => Promise<unknown>,
): ProviderActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(args, conn)) ?? null }
      } catch (err) {
        warn('provider action threw', { connection_id: conn.id, action: name, error: String(err) })
        const code = err instanceof ManagedEngineConfigError ? err.code : 'provider_action_failed'
        return { ok: false, error: { code, message: err instanceof ManagedEngineConfigError ? err.message : String(err) } }
      }
    },
  }
}

export const PROVIDER_ACTIONS: Record<string, ProviderActionSpec> = {
  'model.list': wrap('model.list', 'conversations:read', () => providerApi.listModels()),
  'model.listTiers': wrap('model.listTiers', 'conversations:read', () => providerApi.listModelTiers()),
  'model.resolveTier': wrap('model.resolveTier', 'conversations:read', (args) => providerApi.resolveModelTier(args[0])),
  'provider.getDefault': wrap('provider.getDefault', 'conversations:read', () => providerApi.getDefaultProvider()),
  // The Provider Subscription: the provider key the engine looked up for the
  // signed-in identity. Reading it is `conversations:read`; choosing a
  // subscription or looking up again changes the key a SHARED engine sends,
  // so both are `admin`, like `provider.storeCredential`.
  'provider.subscription': wrap('provider.subscription', 'conversations:read', () => getProviderSubscription()),
  'provider.selectSubscription': wrap('provider.selectSubscription', 'admin', (args) => selectProviderSubscription(args[0])),
  'provider.refreshSubscription': wrap('provider.refreshSubscription', 'admin', () => refreshProviderSubscription()),

  'model.setTier': wrap('model.setTier', 'admin', (args) => providerApi.setModelTier(args[0])),
  'model.removeTier': wrap('model.removeTier', 'admin', (args) => providerApi.removeModelTier(args[0])),
  'model.refresh': wrap('model.refresh', 'admin', (args) => providerApi.refreshModels(args[0])),
  'provider.setDefault': wrap('provider.setDefault', 'admin', (args) => providerApi.setDefaultProvider(args[0])),
  'provider.storeCredential': wrap('provider.storeCredential', 'admin', (args) => providerApi.storeCredential(args[0])),
  // Whether the sign-in can finish depends on where the requester runs, so
  // the connection decides it, never the environment id it addressed.
  'provider.login': wrap('provider.login', 'admin', (args, conn) => providerApi.providerLogin(args[0], connectionOnHost(conn))),
  'provider.loginCancel': wrap('provider.loginCancel', 'admin', (args) => providerApi.providerLoginCancel(args[0])),
  'provider.loginCode': wrap('provider.loginCode', 'admin', (args) => providerApi.providerLoginCode(args[0])),
  'provider.logout': wrap('provider.logout', 'admin', (args) => providerApi.providerLogout(args[0])),

  // The plan-mode Bash allowlist. Server-owned engine configuration like the
  // rest of this table, and it rides here rather than in SETTINGS_ACTIONS
  // because it is engine policy (which commands the engine will run while a
  // conversation is in plan mode), not a per-identity UI preference.
  //
  // Read is `conversations:read` for the same reason `model.list` is: the AI
  // Models settings category renders the list, and a client that may see
  // conversations may see what plan mode is allowed to run. Write is `admin`
  // -- it widens what a SHARED engine will execute without a permission
  // prompt, which is the whole Environment's exposure, not the caller's.
  'planBashAllowlist.get': wrap('planBashAllowlist.get', 'conversations:read', () =>
    Promise.resolve(readPlanBashAllowlist()),
  ),
  // The list is the `planModeAllowedBashCommands` setting, so the enterprise
  // settings policy seals this write the way it seals a `settings.save`.
  'planBashAllowlist.set': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const refusal = settingsSealRefusal(conn, currentEnterprisePolicy(), ['planModeAllowedBashCommands'])
      if (refusal?.code === 'settings_sealed') {
        warn('plan-bash allowlist write refused by enterprise policy', { connection_id: conn.id, transport: conn.transport })
        return { ok: false, error: sealRefusalError(refusal) }
      }
      try {
        writePlanBashAllowlist(Array.isArray(args[0]) ? (args[0] as string[]) : [])
        return { ok: true, value: null }
      } catch (err) {
        warn('provider action threw', { connection_id: conn.id, action: 'planBashAllowlist.set', error: String(err) })
        return { ok: false, error: { code: 'provider_action_failed', message: String(err) } }
      }
    },
  },
}

/** Exported for the dispatcher's logging; keeps the table the single source of names. */
export function isProviderAction(name: string): boolean {
  const known = name in PROVIDER_ACTIONS
  if (known) log('provider action resolved', { action: name })
  return known
}
