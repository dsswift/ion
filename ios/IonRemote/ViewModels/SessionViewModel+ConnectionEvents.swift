import Foundation

// MARK: - Connection-related Event Handlers
//
// Extracted from SessionViewModel+EventHandlers.swift to keep that file
// under the 600-line cap. These handlers deal with pairing/relay lifecycle
// events that arrive from the desktop — `unpair` (pairing revoked) and
// `lan_auth_rejected`. handleRelayConfig lives in
// SessionViewModel+RelayAuth.swift. All handlers run on the MainActor so
// they can mutate published view-model state directly.

extension SessionViewModel {

    @MainActor
    func handleUnpair() {
        // Desktop revoked our pairing -- remove only the active device.
        if let device = activeDevice {
            pairedDevices.removeAll { $0.id == device.id }
            LayoutCache.delete(deviceId: device.id)
        }
        AttachmentImageCache.shared.clearAll()
        // RC-20: also clear the fetcher's transient failed/pending sets so a
        // re-pair starts clean (the byte cache alone doesn't reset those).
        RemoteImageFetcher.shared.resetTransientState()
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

    /// A LAN pairing rejection disables direct LAN retries for this transport.
    /// It does NOT prove anything about relay authentication: a reinstalled
    /// desktop can retain relay pairing state while its LAN pairing registry is
    /// empty, and a live relay socket may still authenticate and return a
    /// snapshot. Locking the entire desktop here created a login loop where a
    /// successful OIDC reauthentication was overwritten by an unrelated LAN
    /// refusal.
    @MainActor
    func handleLANAuthRejected() {
        let relayViable = transport?.relay?.isConnected == true
        DiagnosticLog.log("lan auth rejected by desktop", tag: "session.lifecycle", level: .warn, fields: [
            "device": activeDevice.map { String($0.id.prefix(8)) } ?? "nil",
            "desktop": activeDevice?.name ?? "unknown",
            "relay_viable": String(relayViable),
        ])
        if relayViable {
            markActiveDesktopTransientlyDisconnected(source: "lan_auth_rejected_relay_pending")
            transport?.startSyncHandshake(reason: "lan-auth-rejected-relay-verify")
            return
        }
        markActiveDesktopTransientlyDisconnected(source: "lan_auth_rejected")
        if reconnectSafetyTask == nil {
            reconnectSafetyTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                self.softReconnect()
            }
        }
    }

    /// The desktop knows this device but cannot use its stored pairing secret
    /// (LAN close 4004).
    ///
    /// This is a desktop-side fault, not a refusal of this phone: the secret
    /// on that machine decrypted to ciphertext or to a non-32-byte value,
    /// which happens when its OS keychain grant is lost across a reinstall.
    /// The desktop still holds this phone's `mobileDeviceId`, so the two
    /// devices can resolve it between themselves — `repairPairing` rediscovers
    /// the desktop over Bonjour by its stable `desktopId` and performs a
    /// codeless recovery re-pair, minting fresh ECDH keys and a new channel.
    ///
    /// Deliberately does NOT route to the pairing screen: demanding a PIN for
    /// a fault the machine caused, and can fix, is the failure mode this path
    /// exists to remove.
    ///
    /// Repair attempts are capped per device. A repair that keeps failing must
    /// degrade into a visible, actionable state rather than an invisible retry
    /// loop, so once the cap is reached the desktop is locked as
    /// `.pairingRejected` and the user is routed to a manual re-pair.
    @MainActor
    func handleLANSecretUnusable() {
        guard let device = activeDevice else {
            DiagnosticLog.log("lan secret unusable but no active device", tag: "pairing.repair", level: .warn)
            return
        }

        let attempts = pairingRepairAttempts[device.id, default: 0]
        guard attempts < Self.maxPairingRepairAttempts else {
            DiagnosticLog.log("lan secret unusable, repair attempts exhausted", tag: "pairing.repair", level: .error, fields: [
                "device": String(device.id.prefix(8)),
                "attempts": String(attempts),
                "max": String(Self.maxPairingRepairAttempts)
            ])
            lockDesktop(deviceId: device.id, status: .rejected, reason: .pairingRejected, source: "lan_secret_unusable_repair_exhausted")
            transport?.stop()
            transport = nil
            return
        }
        pairingRepairAttempts[device.id] = attempts + 1

        DiagnosticLog.log("lan secret unusable, starting automatic repair", tag: "pairing.repair", level: .warn, fields: [
            "device": String(device.id.prefix(8)),
            "desktop": device.name,
            "attempt": String(attempts + 1),
            "max": String(Self.maxPairingRepairAttempts)
        ])
        markActiveDesktopTransientlyDisconnected(source: "lan_secret_unusable")

        Task { @MainActor [weak self] in
            guard let self else { return }
            let repaired = await self.repairPairing(device: device)
            guard !Task.isCancelled else { return }
            if repaired {
                // The new pairing has its own device id; clear the counter for
                // the old one so a later, unrelated fault starts fresh.
                self.pairingRepairAttempts.removeValue(forKey: device.id)
                DiagnosticLog.log("lan secret unusable, repair succeeded", tag: "pairing.repair", fields: [
                    "old_device": String(device.id.prefix(8))
                ])
            } else {
                // Repair could not complete (desktop not on this LAN, recovery
                // refused). Do NOT lock the desktop: relay may still be viable
                // and the desktop may return to the LAN later. Fall back to the
                // normal reconnect machinery, which will retry and re-enter
                // this path if the refusal persists.
                DiagnosticLog.log("lan secret unusable, repair failed, deferring to reconnect", tag: "pairing.repair", level: .warn, fields: [
                    "device": String(device.id.prefix(8)),
                    "attempt": String(attempts + 1)
                ])
                self.softReconnect()
            }
        }
    }
}
