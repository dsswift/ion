/**
 * Bonjour/mDNS discovery for relay servers on the local network.
 *
 * Browses for _coda-relay._tcp services advertised by relay servers.
 * Used by the CODA settings UI to auto-fill relay URL and API key fields.
 */

import { EventEmitter } from 'events'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('Discovery', msg)
}

export const RELAY_SERVICE_TYPE = '_coda-relay._tcp'

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
  private browser: any = null
  private bonjour: any = null
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

    try {
      const { Bonjour } = require('bonjour-service')
      this.bonjour = new Bonjour()

      this.browser = this.bonjour.find({ type: 'coda-relay' }, (service: any) => {
        const relay: DiscoveredRelay = {
          id: `${service.host}:${service.port}`,
          name: service.name || service.host || 'Relay',
          host: service.host || '',
          port: service.port || 8443,
          addresses: service.addresses || [],
        }

        // Deduplicate by id.
        if (!this._relays.some((r) => r.id === relay.id)) {
          log(`found relay: ${relay.name} at ${relay.host}:${relay.port}`)
          this._relays.push(relay)
          this.emit('relays-changed', this._relays)
        }
      })

      this._browsing = true
      log('started browsing for _coda-relay._tcp')
    } catch (err) {
      log(`Bonjour unavailable: ${(err as Error).message}`)
    }
  }

  stopBrowsing(): void {
    if (this.browser) {
      try { this.browser.stop() } catch { /* ignore */ }
      this.browser = null
    }
    if (this.bonjour) {
      try { this.bonjour.destroy() } catch { /* ignore */ }
      this.bonjour = null
    }
    this._relays = []
    this._browsing = false
    log('stopped browsing')
  }
}
