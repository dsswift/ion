/**
 * nearby-browser -- one bounded look at the LAN for Studio Servers.
 *
 * Listens for `_ion-studio._tcp` announcements for a few seconds and
 * returns what answered. Bounded on purpose: Add Environment asks when the
 * person opens the Nearby door (and again on "Search again"), so nothing
 * browses in the background. Servers are silent unless someone made them
 * discoverable, so an empty answer is the normal case.
 */
import { Bonjour } from 'bonjour-service'
import { asBonjourOptions, multicastOptionsPerInterface, type MulticastInterfaceOptions } from '@ion/shared/multicast-interfaces'
import { NEARBY_BROWSE_MS, type NearbyStudioServer } from '@ion/shared/types-nearby'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('nearby-browser', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('nearby-browser', msg, fields) }

const STUDIO_SERVICE_TYPE = 'ion-studio'

interface AnnouncedService {
  name?: string
  host?: string
  port?: number
  txt?: Record<string, unknown>
  /** A/AAAA records the announcement carried. */
  addresses?: string[]
  /** The packet's sender, when it carried no address records. */
  referer?: { address?: string }
}

/**
 * The address to dial, from one announcement.
 *
 * An announcement's SRV target is whatever the publisher called itself, and
 * a default publisher uses the machine's bare hostname (`macbook`), which
 * resolves nowhere: a Mac answers to `macbook.local`. So the announced IP
 * is preferred -- it is the address the packet actually came from and needs
 * no resolver -- and a bare name is only used after `.local` is restored.
 * IPv6 is skipped: a link-local address needs a zone index a URL cannot
 * carry, and any server announcing v6 announces v4 beside it.
 */
function dialHost(service: AnnouncedService, host: string): string {
  const v4 = (service.addresses ?? []).find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a))
  if (v4) return v4
  const referer = service.referer?.address ?? ''
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(referer)) return referer
  return host.includes('.') ? host : `${host}.local`
}

/** Turns one announcement into a row, or null when it names no usable address. */
export function nearbyFromService(service: AnnouncedService): NearbyStudioServer | null {
  const host = (service.host ?? '').replace(/\.$/, '')
  const port = service.port ?? 0
  if (!host || !port) return null
  const txt = service.txt ?? {}
  const text = (key: string): string => (typeof txt[key] === 'string' ? (txt[key] as string) : '')
  return {
    environmentId: text('id'),
    label: text('label') || service.name || host,
    serverVersion: text('v'),
    host,
    port,
    url: `http://${dialHost(service, host)}:${port}`,
  }
}

export interface BrowseDeps {
  /** Injectable for tests: starts a browse, calls `onService` per announcement, returns a stop function. */
  browse?: (onService: (service: AnnouncedService) => void) => () => void
  durationMs?: number
}

/**
 * One browser per real interface (see @ion/shared/multicast-interfaces):
 * the library's single default responder queries on whichever interface the
 * OS picks, which on a Windows host with a virtual switch is not the LAN.
 */
function bonjourBrowse(onService: (service: AnnouncedService) => void): () => void {
  const perInterface = multicastOptionsPerInterface()
  const options: Array<MulticastInterfaceOptions | undefined> = perInterface.length > 0 ? perInterface : [undefined]
  const instances = options.map((opts) => {
    const bonjour = new Bonjour(asBonjourOptions(opts))
    const browser = bonjour.find({ type: STUDIO_SERVICE_TYPE }, (service) => onService(service as AnnouncedService))
    return { bonjour, browser, interface: opts?.interface ?? 'default' }
  })
  log('browsing on interfaces', { interfaces: instances.map((i) => i.interface).join(',') })
  return () => {
    for (const { bonjour, browser, interface: name } of instances) {
      try { browser.stop() } catch (err) { warn('browser stop failed', { interface: name, error: String(err) }) }
      try { bonjour.destroy() } catch (err) { warn('bonjour destroy failed', { interface: name, error: String(err) }) }
    }
  }
}

export function browseNearby(deps: BrowseDeps = {}): Promise<NearbyStudioServer[]> {
  const durationMs = deps.durationMs ?? NEARBY_BROWSE_MS
  return new Promise((resolve) => {
    const found = new Map<string, NearbyStudioServer>()
    let stop: () => void = () => {}
    try {
      stop = (deps.browse ?? bonjourBrowse)((service) => {
        const row = nearbyFromService(service)
        if (!row) { log('announcement ignored: no usable address', { name: service.name ?? '' }); return }
        found.set(row.environmentId || row.url, row)
      })
    } catch (err) {
      warn('browse could not start', { error: String(err) })
      resolve([])
      return
    }
    log('browsing the LAN for studio servers', { duration_ms: durationMs })
    setTimeout(() => {
      stop()
      const rows = [...found.values()].sort((a, b) => a.label.localeCompare(b.label))
      log('browse finished', { found: rows.length })
      resolve(rows)
    }, durationMs)
  })
}
