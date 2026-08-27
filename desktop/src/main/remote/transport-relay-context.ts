import type { RelayClient } from './relay-client'
import type { PairedDevice } from './protocol'
import type { RelayReconcileCtx } from './transport-relay-wiring'
import type { RemoteTransportConfig } from './transport'

/** Build the shared relay-reconciliation context without extending RemoteTransport. */
export function createRelayReconcileCtx(
  config: RemoteTransportConfig,
  relays: Map<string, RelayClient>,
  connectRelayForDevice: (device: PairedDevice) => void,
): RelayReconcileCtx {
  return {
    relayUrl: config.relayUrl,
    relayApiKey: config.relayApiKey,
    getCredential: config.getCredential,
    relays,
    getPairedDevice: (id) => config.getPairedDevice?.(id) || null,
    getAllPairedDevices: () => config.getAllPairedDevices?.() || [],
    connectRelayForDevice,
  }
}
