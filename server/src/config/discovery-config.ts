/**
 * `server.json.discovery` -- LAN discovery. `advertise: true` announces this
 * server on the local network for as long as it runs: the setting for a
 * headless host, changed by redeploying its config. Default false: a server
 * is silent unless a person opens a timed window from a desktop
 * (`environment.discovery.open`). An enterprise seal
 * (`@ion/shared/enterprise-lan-discovery`) overrides both.
 */
export interface ServerDiscoveryConfig {
  advertise: boolean
}

export function defaultDiscoveryConfig(): ServerDiscoveryConfig {
  return { advertise: false }
}

/** Only an explicit `advertise: true` turns the announcement on; anything else is silent. */
export function parseDiscovery(raw: unknown): ServerDiscoveryConfig {
  return { advertise: !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).advertise === true }
}
