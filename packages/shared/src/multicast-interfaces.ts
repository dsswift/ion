/**
 * Which interfaces mDNS traffic leaves on.
 *
 * multicast-dns sends every announcement and answer through one multicast
 * interface. Off macOS it names that interface `0.0.0.0` and lets the OS
 * choose, and Windows chooses by adapter order rather than by route: on a
 * host with a Hyper-V or WSL virtual switch beside its real NIC, every
 * answer left on the virtual switch and a peer on the LAN never heard one.
 * Queries still arrived (the socket joins the group on every interface), so
 * the responder looked healthy from its own logs.
 *
 * So each real IPv4 interface gets its own responder, pinned to that
 * interface for sending and joined to the group on it for receiving, while
 * still bound to `0.0.0.0` (the only bind that receives multicast on
 * Windows). A query arriving on one interface is answered on that
 * interface. Shared by the advertiser and both browsers, so a host that
 * cannot be seen cannot see either, and the fix lands once.
 */
import { networkInterfaces } from 'os'

export interface MulticastInterfaceOptions {
  /** The address multicast leaves on and the group is joined on. */
  interface: string
  /** Always the wildcard: a socket bound to one address receives no multicast on Windows. */
  bind: '0.0.0.0'
}

/**
 * One option set per non-internal IPv4 interface, in the OS's order. Empty
 * on a host with no LAN interface at all, where the caller falls back to
 * the library's single default responder.
 */
export function multicastOptionsPerInterface(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): MulticastInterfaceOptions[] {
  const seen = new Set<string>()
  const out: MulticastInterfaceOptions[] = []
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || seen.has(entry.address)) continue
      seen.add(entry.address)
      out.push({ interface: entry.address, bind: '0.0.0.0' })
    }
  }
  return out
}

/**
 * bonjour-service forwards its constructor options to multicast-dns
 * unchanged but declares them as its service config, which has no room for
 * the interface options. `T` is that declared parameter type, inferred at
 * the call site; this is the one place the gap is bridged.
 */
export function asBonjourOptions<T>(options: MulticastInterfaceOptions | undefined): T | undefined {
  return options as unknown as T | undefined
}
