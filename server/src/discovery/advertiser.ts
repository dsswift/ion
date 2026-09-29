/**
 * discovery/advertiser — announces this Studio Server on the LAN as
 * `_ion-studio._tcp` so a desktop's Add Environment can list it.
 *
 * The announcement is only an address book entry: the server's label, its
 * environment id, its version, and the port. It grants nothing. Pairing
 * still needs the one-time code `discovery/window.ts` shows, or a link.
 *
 * `bonjour-service` rather than the `dns-sd` child the iOS advertiser
 * (`remote/lan-bonjour.ts`) owns: that one is macOS-only, and a headless
 * Studio Server is as often a Linux box.
 */
import { Bonjour, type Service } from 'bonjour-service'
import { hostname } from 'os'
import { asBonjourOptions, multicastOptionsPerInterface, type MulticastInterfaceOptions } from '@ion/shared/multicast-interfaces'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'discovery.advertiser'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export const STUDIO_SERVICE_TYPE = 'ion-studio'

/**
 * The `.local` name this server publishes for itself, and the SRV target a
 * client resolves to reach it.
 *
 * It has to satisfy two constraints at once, and the two obvious names each
 * break one of them:
 *
 *  - The machine's own `<host>.local` RESOLVES but is already claimed. The OS
 *    defends it, and the OS wins: publishing it made macOS rename the machine
 *    to `jolteon-2` and tell the operator its name was "already in use on this
 *    network" — by us, on their own machine.
 *  - The bare `os.hostname()` claims NOTHING but resolves nowhere: it carries
 *    no `.local` suffix, so no responder ever answers it. `dns-sd -G v4
 *    jolteon` returns "No Such Record" while `jolteon.local` returns the
 *    address. A browser that dials the announced IP instead never notices;
 *    one that resolves the service endpoint through the OS — iOS — gets
 *    nothing back and falls back to its relay.
 *
 * So the published name is neither: a `.local` name derived from the
 * environment id, which resolves because we answer for it and collides with
 * nothing because no one else claims it. Stable across restarts, since the
 * environment id is.
 */
export function advertisedHostname(environmentId: string, fallback: string = hostname()): string {
  const slug = (environmentId || fallback).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase()
  return slug ? `ion-${slug}.local` : 'ion-studio.local'
}

export interface Advertisement {
  label: string
  environmentId: string
  serverVersion: string
  /** The Studio wire's TCP port: what a desktop dials. */
  port: number
  /**
   * The host's machine id, or '' when the platform reported none. A phone
   * paired on the `desktop_*` wire stored this as its server's id, so it is
   * how that phone recognises the same server among several on a network.
   */
  machineId: string
}

export interface Advertiser {
  start(ad: Advertisement): void
  stop(): void
  readonly advertising: boolean
}

/** One responder: the library instance pinned to one interface and the service it publishes. */
interface Responder {
  bonjour: Bonjour
  service: Service
  interface: string
}

export class BonjourStudioAdvertiser implements Advertiser {
  private responders: Responder[] = []

  /** `interfaces` is injectable for tests; production reads the host's own. */
  constructor(private readonly interfaces: () => MulticastInterfaceOptions[] = () => multicastOptionsPerInterface()) {}

  get advertising(): boolean { return this.responders.length > 0 }

  start(ad: Advertisement): void {
    if (this.responders.length > 0) {
      log('already advertising; left as is', { label: ad.label })
      return
    }
    // `host` is deliberately not set to the machine's own name.
    //
    // This publisher emits an A record NAMED after `host` for every local
    // address (`RecordA(service, ip) => { name: service.host }`). Passing
    // the machine's real `.local` name therefore claims a name the OS
    // already defends, and the OS is the one that yields: macOS detected
    // the duplicate claim and renamed itself from `jolteon.local` to
    // `jolteon-2.local`, telling the operator their computer's name was
    // "already in use on this network" -- by us, on their own machine.
    //
    // `host` names the SRV target AND the A record published beside it, so
    // it must be a name we may claim and a name that resolves. See
    // `advertisedHostname`: the machine's own name fails the first test and
    // a bare host name fails the second.
    const dialHost = advertisedHostname(ad.environmentId)
    const config = {
      name: `Ion Studio (${ad.label})`,
      type: STUDIO_SERVICE_TYPE,
      host: dialHost,
      port: ad.port,
      txt: { label: ad.label, id: ad.environmentId, v: ad.serverVersion, ...(ad.machineId ? { machine: ad.machineId } : {}) },
    }
    // One responder per real interface (see @ion/shared/multicast-interfaces); a host
    // with none gets the library's single default responder.
    const perInterface = this.interfaces()
    const targets: Array<{ options: MulticastInterfaceOptions | undefined; interface: string }> = perInterface.length > 0
      ? perInterface.map((options) => ({ options, interface: options.interface }))
      : [{ options: undefined, interface: 'default' }]
    for (const target of targets) {
      try {
        const bonjour = new Bonjour(asBonjourOptions(target.options))
        const service = bonjour.publish(config)
        service.on('error', (err: unknown) => warn('advertisement error', { label: ad.label, interface: target.interface, error: String(err) }))
        this.responders.push({ bonjour, service, interface: target.interface })
      } catch (err) {
        warn('could not start advertising on an interface', { label: ad.label, interface: target.interface, error: String(err) })
      }
    }
    if (this.responders.length === 0) {
      warn('could not start advertising', { label: ad.label })
      return
    }
    log('advertising on the LAN', { label: ad.label, environment_id: ad.environmentId, has_machine_id: ad.machineId !== '', port: ad.port, dial_host: dialHost, interfaces: this.responders.map((r) => r.interface).join(',') })
  }

  stop(): void {
    const wasAdvertising = this.responders.length > 0
    for (const responder of this.responders) {
      try {
        responder.service.stop?.()
      } catch (err) {
        warn('service stop failed', { interface: responder.interface, error: String(err) })
      }
      try {
        responder.bonjour.destroy()
      } catch (err) {
        warn('bonjour destroy failed', { interface: responder.interface, error: String(err) })
      }
    }
    this.responders = []
    if (wasAdvertising) log('stopped advertising on the LAN')
  }
}
