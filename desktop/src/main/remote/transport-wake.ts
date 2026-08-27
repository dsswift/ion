import type { RemoteTransport } from './transport'

export interface RelayWakeDeps {
  transport: RemoteTransport | null
  log: (msg: string, fields?: Record<string, unknown>) => void
}

/** Renew relay sockets after macOS resumes from sleep without rebuilding LAN state. */
export function renewRelaysAfterWake({ transport, log }: RelayWakeDeps): void {
  if (transport === null) {
    log('remote_transport: wake relay renewal skipped, no transport')
    return
  }
  transport.reconnectRelays()
  log('remote_transport: relay sockets renewed after system wake')
}
