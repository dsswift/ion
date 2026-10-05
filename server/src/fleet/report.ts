/**
 * The Fleet Report: one server's facts, load, providers, and accounts, built
 * the same way for a paired client that asks and for a Fleet Hub the server
 * reports to.
 */
import type { FleetEnterpriseAccount, FleetProvider, FleetReport } from '@ion/shared/types-fleet'
import type { ModelEntry, ProviderEntry } from '@ion/shared/types-models'
import type { ModelTier } from '@ion/shared/types-model-tiers'
import { connectionRegistry, type Connection } from '../protocol/connection'
import { bootedEnvironmentServerVersion } from '../environment/actions'
import { serverInfoWithInstall } from '../environment/host-install'
import { readEngineRuntime } from '../compat/runtime'
import { engineBridge } from '../state'
import { systemMetricsPublisher } from '../system-metrics/runtime'
import { credentialsStore } from '../auth/credentials-store'
import { listClients } from '../auth/pairing-links'
import { devicesOf } from '../auth/devices'
import * as providerApi from '../engine/provider-api'
import { getSignedInIdentityIfEngineConnected } from '../oauth/entra-flow'
import { listAccounts } from './account-ledger'
import { fleetHubLinks } from './hub-links'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.report', msg, fields)
}

export interface FleetDeviceCounts {
  paired: number
  connected: number
}

async function part<T>(name: string, read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read()
  } catch (err) {
    warn('fleet report part unavailable', { part: name, error: String(err) })
    return empty
  }
}

function fleetProviders(listing: { models?: ModelEntry[]; providers?: ProviderEntry[] }): FleetProvider[] {
  const counts = new Map<string, number>()
  for (const model of listing.models ?? []) counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1)
  return (listing.providers ?? []).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    hasAuth: p.hasAuth,
    authSource: p.authSource,
    backend: p.backend,
    cli: p.cli,
    modelCount: counts.get(p.id) ?? 0,
    ...(p.custom ? { custom: true } : {}),
  }))
}

/** The other devices of the person asking: the device that asks is not one of its own Fleet's devices. */
export function deviceCountsFor(conn: Connection): FleetDeviceCounts {
  const subject = conn.principal?.subject
  if (!subject) return { paired: 0, connected: 0 }
  const others = devicesOf(listClients(credentialsStore()), connectionRegistry.all(), subject, conn.pairedClientId).filter((d) => !d.self)
  return { paired: others.length, connected: others.filter((d) => d.connected).length }
}

/** Every device paired with this server, whoever it belongs to: what a hub, which is nobody's device, is told. */
export function hostDeviceCounts(): FleetDeviceCounts {
  const paired = listClients(credentialsStore()).length
  const connected = new Set<string>()
  for (const conn of connectionRegistry.all()) if (conn.pairedClientId) connected.add(conn.pairedClientId)
  return { paired, connected: connected.size }
}

/** Who is signed in to this server's enterprise sign-in; null when nobody is. */
async function enterpriseAccount(): Promise<FleetEnterpriseAccount | null> {
  const identity = await getSignedInIdentityIfEngineConnected()
  return identity ? { username: identity.username, displayName: identity.displayName } : null
}

export async function buildFleetReport(devices: FleetDeviceCounts): Promise<FleetReport> {
  const [runtime, listing, modelTiers, defaultProvider, enterprise] = await Promise.all([
    readEngineRuntime(engineBridge),
    part('models', async () => (await providerApi.listModels()) as { models?: ModelEntry[]; providers?: ProviderEntry[] }, {}),
    part('model tiers', async () => (await providerApi.listModelTiers()) as ModelTier[], []),
    part('default provider', () => providerApi.getDefaultProvider(), ''),
    part('enterprise sign-in', enterpriseAccount, null),
  ])
  return {
    generatedAt: Date.now(),
    server: serverInfoWithInstall(bootedEnvironmentServerVersion(), runtime),
    metrics: systemMetricsPublisher()?.latest() ?? null,
    devices,
    providers: fleetProviders(listing),
    defaultProvider,
    modelTiers: Array.isArray(modelTiers) ? modelTiers : [],
    accounts: listAccounts(),
    enterpriseAccount: enterprise,
    hubs: (fleetHubLinks()?.list().hubs ?? []).map((h) => ({ url: h.url, label: h.label, state: h.state, manage: h.manage })),
  }
}
