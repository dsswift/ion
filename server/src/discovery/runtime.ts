/**
 * discovery/runtime — the one `DiscoveryWindow` of this server process,
 * wired to its real config, policy, identity, and advertiser.
 *
 * `main.ts` starts it once the environment id and port are known and
 * reconciles it again whenever the enterprise policy is (re)cached, since
 * the seal can arrive after boot. Actions reach it through `discovery()`.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { currentServerConfig } from '../config/current'
import { enterprisePolicyCache } from '../state'
import { broadcast } from '../broadcast'
import { DISCOVERY_CHANNEL } from '@ion/shared/types-environment-admin'
import { BonjourStudioAdvertiser, type Advertiser } from './advertiser'
import { DiscoveryWindow } from './window'
import { log as _log } from '../logger'
import { getMachineIdentity } from '../machine-identity'

function log(msg: string, fields?: Record<string, unknown>): void { _log('discovery.runtime', msg, fields) }


export interface DiscoveryIdentity {
  environmentId: () => string
  serverVersion: string
  port: number
}

let instance: DiscoveryWindow | null = null

export function startDiscovery(identity: DiscoveryIdentity, advertiser: Advertiser = new BonjourStudioAdvertiser()): DiscoveryWindow {
  instance?.dispose()
  instance = new DiscoveryWindow({
    advertiser,
    // Read per announcement, not once: the mobile door can be switched on
    // (or moved to another port) while the server runs, and an announcement
    // that named a stale port would send a phone nowhere.
    advertisement: () => ({ label: currentServerConfig().label, environmentId: identity.environmentId(), serverVersion: identity.serverVersion, port: identity.port, machineId: getMachineIdentity()?.machineId ?? '' }),
    policy: () => enterprisePolicyCache.policy,
    persistent: () => currentServerConfig().discovery.advertise,
    defaultScopes: () => [...currentServerConfig().pairing.defaultScopes] as Scope[],
    onChange: (status) => broadcast(DISCOVERY_CHANNEL, status),
  })
  log('discovery runtime started', { port: identity.port, persistent: currentServerConfig().discovery.advertise })
  instance.reconcile()
  return instance
}

export function discovery(): DiscoveryWindow | null {
  return instance
}

export function stopDiscovery(): void {
  instance?.dispose()
  instance = null
}
