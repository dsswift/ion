import Foundation

extension SessionViewModel {

    /// Re-pair with the active device's desktop over LAN to generate fresh ECDH
    /// keys and a new relay channel, bypassing a wrong-owner 403.
    ///
    /// Uses Bonjour to discover the desktop by its stable `desktopId`, then
    /// performs a codeless recovery re-pair (the desktop already knows this
    /// phone's `mobileDeviceId`). On success the old pairing entry is removed
    /// and the new one takes over as the active device.
    @MainActor
    func repairPairing(device: PairedDevice) async -> Bool {
        let oldDeviceId = device.id
        let desktopId = device.desktopId

        guard let desktopId, !desktopId.isEmpty else {
            DiagnosticLog.log("repair pairing: no desktopId on device", tag: "pairing.repair", level: .warn, fields: [
                "device": String(oldDeviceId.prefix(8))
            ])
            return false
        }

        DiagnosticLog.log("repair pairing: starting LAN discovery", tag: "pairing.repair", fields: [
            "device": String(oldDeviceId.prefix(8)),
            "desktop_id": desktopId
        ])

        pairingBrowser.startBrowsing()
        defer { pairingBrowser.stopBrowsing() }

        let discovered = await discoverDesktop(desktopId: desktopId, timeout: 5.0)
        guard let host = discovered else {
            DiagnosticLog.log("repair pairing: desktop not found on LAN", tag: "pairing.repair", level: .warn, fields: [
                "device": String(oldDeviceId.prefix(8)),
                "desktop_id": desktopId,
                "hosts_seen": String(pairingBrowser.discoveredHosts.count)
            ])
            return false
        }

        DiagnosticLog.log("repair pairing: desktop found, starting recovery re-pair", tag: "pairing.repair", fields: [
            "device": String(oldDeviceId.prefix(8)),
            "host": host.host,
            "port": String(host.port)
        ])

        let success = await recoveryPair(
            host: host.host,
            port: host.port,
            name: host.name
        )

        guard success else {
            DiagnosticLog.log("repair pairing: recovery re-pair failed", tag: "pairing.repair", level: .error, fields: [
                "device": String(oldDeviceId.prefix(8))
            ])
            pairingState = .idle
            return false
        }

        // recoveryPair added the new device with a new id (new ECDH keys = new
        // channelId). Remove the old entry and clean up its state.
        if activeDevice?.id != oldDeviceId {
            relayIdentityMismatch.remove(oldDeviceId)
            oidcRegistry.remove(deviceId: oldDeviceId)
            pairedDevices.removeAll { $0.id == oldDeviceId }
            LayoutCache.delete(deviceId: oldDeviceId)
            deviceOnlineStatus.removeValue(forKey: oldDeviceId)
            savePairedDevices()
            DiagnosticLog.log("repair pairing: removed superseded device entry", tag: "pairing.repair", fields: [
                "old_id": String(oldDeviceId.prefix(8)),
                "new_id": String((activeDevice?.id ?? "").prefix(8))
            ])
        } else {
            // recoveryPair updated in place (same channelId, unlikely but safe).
            relayIdentityMismatch.remove(oldDeviceId)
        }

        DiagnosticLog.log("repair pairing: succeeded", tag: "pairing.repair", fields: [
            "old_id": String(oldDeviceId.prefix(8)),
            "new_id": String((activeDevice?.id ?? "").prefix(8))
        ])
        pairingState = .idle
        return true
    }

    /// Poll Bonjour discovery until the target desktop appears or timeout.
    private func discoverDesktop(desktopId: String, timeout: Double) async -> DiscoveredService? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let match = pairingBrowser.discoveredHosts.first { host in
                host.kind == .ionDirect && host.metadata["desktopId"] == desktopId
            }
            if let match { return match }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return nil
    }
}
