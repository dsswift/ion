/**
 * Bonjour/mDNS discovery for relay servers on the local network.
 *
 * Browses for _ion-relay._tcp services advertised by relay servers.
 * Used by the Ion settings UI to auto-fill relay URL and API key fields.
 */

import { EventEmitter } from 'events'
import { Bonjour } from 'bonjour-service'
import { log as _log } from '../logger'
import { asBonjourOptions, multicastOptionsPerInterface, type MulticastInterfaceOptions } from '@ion/shared/multicast-interfaces'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('Discovery', msg, fields)
}

export const RELAY_SERVICE_TYPE = '_ion-relay._tcp'

export interface DiscoveredRelay {
  id: string
  name: string
  host: string
  port: number
  addresses: string[]
}

/**
 * Events:
 *  - 'relays-changed' (relays: DiscoveredRelay[]) -- list updated
 */
export class RelayDiscovery extends EventEmitter {
  private instances: Array<{ bonjour: any; browser: any }> = []
  private _relays: DiscoveredRelay[] = []
  private _browsing = false

  get relays(): DiscoveredRelay[] {
    return this._relays
  }

  get browsing(): boolean {
    return this._browsing
  }

  startBrowsing(): void {
    if (this._browsing) return

    // One browser per real interface (see @ion/shared/multicast-interfaces):
    // a single default instance queries on whichever interface the OS picks,
    // which on a Windows host with a virtual switch is not the LAN.
    const perInterface = multicastOptionsPerInterface()
    const options: Array<MulticastInterfaceOptions | undefined> = perInterface.length > 0 ? perInterface : [undefined]
    try {
      for (const opts of options) {
        const bonjour = new Bonjour(asBonjourOptions(opts))
        const browser = bonjour.find({ type: 'ion-relay' }, (service: any) => {
          const relay: DiscoveredRelay = {
            id: `${service.host}:${service.port}`,
            name: service.name || service.host || 'Relay',
            host: service.host || '',
            port: service.port || 8443,
            addresses: service.addresses || [],
          }

          // Deduplicate by id.
          if (!this._relays.some((r) => r.id === relay.id)) {
            log('discovery: found relay', { name: relay.name, relay_host: relay.host, port: relay.port })
            this._relays.push(relay)
            this.emit('relays-changed', this._relays)
          }
        })
        this.instances.push({ bonjour, browser })
      }

      this._browsing = true
      log('started browsing for _ion-relay._tcp', { interfaces: options.map((o) => o?.interface ?? 'default').join(',') })
    } catch (err) {
      log('discovery: bonjour unavailable', { error: (err as Error).message })
    }
  }

  stopBrowsing(): void {
    for (const { bonjour, browser } of this.instances) {
      try { browser.stop() } catch (err) { log('discovery: browser stop failed', { error: String(err) }) }
      try { bonjour.destroy() } catch (err) { log('discovery: bonjour destroy failed', { error: String(err) }) }
    }
    this.instances = []
    this._relays = []
    this._browsing = false
    log('stopped browsing')
  }
}
