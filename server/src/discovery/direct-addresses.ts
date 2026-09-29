/**
 * discovery/direct-addresses — where this server can be reached on the LAN.
 *
 * A paired client keeps one address and probes it before falling back to a
 * relay, so being reachable directly depends entirely on that address being
 * right. It used to come only from a Bonjour browse, which made the direct
 * route a function of whether LAN advertising happened to be on: a client
 * paired over a relay never learned an address at all, and one whose stored
 * address went stale could only be repaired by switching advertising back on.
 *
 * These are sent on every welcome instead, so the address survives a pairing
 * made over a relay, a port change, and a DHCP lease change, without the
 * client discovering anything. Discovery is for finding a server to pair
 * with; this is for staying reachable afterwards.
 *
 * Literal IPv4 addresses come first, because an address needs no resolver.
 * IPv6 link-local needs a zone index a URL cannot carry, so it is left out.
 *
 * The machine's own `.local` name comes last. A literal address is only
 * right on the network the server is on NOW: carry the laptop to another
 * network and every address a client stored is dead. The name follows the
 * machine, because the OS answers for it on whatever network it joins. A
 * client tries it when its stored addresses stay silent.
 */
import { execFileSync } from 'child_process'
import { hostname, networkInterfaces } from 'os'
import { log as _log, warn as _warn } from '../logger'

/** The LAN URLs this server answers on, most useful first. Empty when it has no non-loopback IPv4 address. */
export function directAddresses(port: number, interfaces = networkInterfaces()): string[] {
  const urls: string[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // `family` is 'IPv4' on modern Node and 4 on older builds; accept both
      // rather than pinning one and silently returning nothing.
      const isV4 = entry.family === 'IPv4' || (entry.family as unknown as number) === 4
      if (!isV4 || entry.internal) continue
      urls.push(`http://${entry.address}:${port}`)
    }
  }
  return urls
}

export interface LanHostnameDeps {
  platform?: NodeJS.Platform
  /** Reads macOS's Bonjour name (`scutil --get LocalHostName`). */
  localHostName?: () => string
  hostname?: () => string
}

function readLocalHostName(): string {
  return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim()
}

/**
 * The `.local` name the OS answers for on the LAN, or '' when there is none.
 *
 * On macOS that is the LocalHostName, which is what mDNSResponder defends.
 * `os.hostname()` is not always the same thing there: a DHCP server can hand
 * the Mac a different name, and that name is not the one answered on `.local`.
 * Elsewhere the responder (avahi, Windows) answers for the host name itself.
 */
export function lanHostname(deps: LanHostnameDeps = {}): string {
  const platform = deps.platform ?? process.platform
  let name = ''
  if (platform === 'darwin') {
    try {
      name = (deps.localHostName ?? readLocalHostName)()
    } catch (err) {
      _warn('discovery.direct', 'could not read the LocalHostName; using the host name', { error: String(err) })
    }
  }
  if (!name) name = (deps.hostname ?? hostname)()
  // The first label only: `dcitag8331.corp.example.com` answers as `dcitag8331.local`.
  const label = name.replace(/\.local\.?$/i, '').split('.')[0]?.trim() ?? ''
  return label ? `${label}.local` : ''
}

let cachedLanHostname: string | null = null

/**
 * Every URL a paired client may try: the literal addresses, then the `.local`
 * name. The name is read once per process; it changes only when the operator
 * renames the machine, which a restart picks up.
 */
export function reachableAddresses(port: number, interfaces = networkInterfaces(), name: string = (cachedLanHostname ??= lanHostname())): string[] {
  const urls = directAddresses(port, interfaces)
  if (name) urls.push(`http://${name}:${port}`)
  return urls
}

/** `reachableAddresses`, logged: an empty result is a client stranded on its relay, and must be visible. */
export function loggedDirectAddresses(port: number): string[] {
  const urls = reachableAddresses(port)
  if (urls.length === 0) {
    _log('discovery.direct', 'no LAN address to offer; paired clients can only use a relay', { port })
  } else {
    _log('discovery.direct', 'offering LAN addresses to paired clients', { port, addresses: urls.join(',') })
  }
  return urls
}
