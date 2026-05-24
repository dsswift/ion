import Foundation

// MARK: - Connection-related Event Handlers
//
// Extracted from SessionViewModel+EventHandlers.swift to keep that file
// under the 600-line cap. These handlers deal with pairing/relay lifecycle
// events that arrive from the desktop — `unpair` (pairing revoked) and
// `relay_config` (relay URL/key updated). They run on the MainActor so they
// can mutate the published view-model state directly.

extension SessionViewModel {

    @MainActor
    func handleUnpair() {
        // Desktop revoked our pairing -- remove only the active device.
        if let device = activeDevice {
            pairedDevices.removeAll { $0.id == device.id }
            LayoutCache.delete(deviceId: device.id)
        }
        AttachmentImageCache.shared.clearAll()
        savePairedDevices()
        if pairedDevices.isEmpty {
            try? KeychainStore.deleteAll()
            activeDeviceId = nil
            pairingState = .idle
            disconnect()
        } else {
            // Switch to the next available device.
            let nextId = pairedDevices.first!.id
            switchToDevice(id: nextId)
        }
    }

    @MainActor
    func handleRelayConfig(relayUrl: String, relayApiKey: String) {
        // Desktop pushed updated relay config -- persist it for roaming.
        // Guard: if the active device is a LAN-only pairing (apiKey "lan-direct")
        // and the incoming config doesn't provide BOTH a relay URL and API key,
        // keep the LAN-direct sentinel intact. Without this, a desktop with no
        // relay would overwrite the "lan-direct" marker, breaking reconnects.
        // A legitimate relay upgrade must provide both values.
        if let device = activeDevice, device.relayAPIKey == "lan-direct" {
            guard !relayUrl.isEmpty, !relayApiKey.isEmpty else {
                DiagnosticLog.log("RELAY-CFG: rejected empty for lan-direct \(device.name)")
                print("[Ion] handleRelayConfig: ignoring incomplete relay config for LAN-direct device \(device.name)")
                return
            }
            // Legitimate upgrade from LAN-direct to relay — fall through.
        }

        self.relayURL = relayUrl
        self.relayAPIKey = relayApiKey
        if let device = activeDevice,
           let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            pairedDevices[idx].relayURL = relayUrl
            pairedDevices[idx].relayAPIKey = relayApiKey
            savePairedDevices()
            DiagnosticLog.log("RELAY-CFG: accepted for \(device.id.prefix(8))")
        }
    }
}
