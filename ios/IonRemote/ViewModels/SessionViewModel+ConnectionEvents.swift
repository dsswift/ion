import Foundation

// MARK: - Connection-related Event Handlers
//
// Extracted from SessionViewModel+EventHandlers.swift to keep that file
// under the 600-line cap. These handlers deal with pairing/relay lifecycle
// events that arrive from the server — `unpair` (pairing revoked) and
// `lan_auth_rejected`. All handlers run on the MainActor so they can mutate
// published view-model state directly.

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
            do {
                try KeychainStore.deleteAll()
            } catch {
                DiagnosticLog.log("keychain purge after unpair failed", tag: "pairing", level: .error, fields: [
                    "error": error.localizedDescription
                ])
            }
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
        let relayViable = transport?.relayIsConnected == true
        DiagnosticLog.log("lan auth rejected by desktop", tag: "session.lifecycle", level: .warn, fields: [
            "device": activeDevice.map { String($0.id.prefix(8)) } ?? "nil",
            "desktop": activeDevice?.name ?? "unknown",
            "relay_viable": String(relayViable),
        ])
        if transport?.authRejectionIsFinal == true, let device = activeDevice {
            // One credential serves every route, so there is no other leg to
            // check: the server refused this pairing.
            lockServer(deviceId: device.id, status: .rejected, reason: .pairingRejected, source: "studio_credential_rejected")
            transport?.stop()
            transport = nil
            return
        }
        if relayViable {
            markActiveServerTransientlyDisconnected(source: "lan_auth_rejected_relay_pending")
            transport?.startSyncHandshake(reason: "lan-auth-rejected-relay-verify")
            return
        }
        markActiveServerTransientlyDisconnected(source: "lan_auth_rejected")
        if reconnectSafetyTask == nil {
            reconnectSafetyTask = Task { @MainActor [weak self] in
                // Only CancellationError can surface; the guard below re-checks cancellation.
                // swiftlint:disable:next silent_try_optional
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                self.softReconnect()
            }
        }
    }
}
