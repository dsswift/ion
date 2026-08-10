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

    /// A definitive LAN auth rejection surfaced by the transport's Bonjour
    /// auto-reconnect loop: the desktop does not know this device identity
    /// (explicit auth_result success=false, or an application close
    /// 4000–4999 such as 4003 "unknown device"). A desktop that doesn't
    /// know the identity rejects it on every transport — relay included —
    /// so the pairing is dead and the user must re-pair. Mirrors the
    /// `.rejected` arm of the user-initiated `connectLAN` path in
    /// SessionViewModel+Lifecycle.swift.
    ///
    /// Two invariants, both pinned by tests:
    /// - `pairedDevices` is NOT touched. `.authFailed` routes to the pairing
    ///   screen (IonRemoteApp) but never auto-wipes — see the pairing-wipe
    ///   incident documented in SessionViewModelLanAuthTransientTests.
    /// - The reconnect safety timer is cancelled so it cannot softReconnect
    ///   the same dead identity behind the pairing screen.
    @MainActor
    func handleLANAuthRejected() {
        DiagnosticLog.log("lan auth rejected by desktop, routing to pairing", tag: "session.lifecycle", level: .warn, fields: [
            "device": activeDevice.map { String($0.id.prefix(8)) } ?? "nil",
            "reason": activeDevice?.name ?? "unknown"
        ])
        cancelReconnectSafetyTimer()
        if let device = activeDevice {
            lockDesktop(deviceId: device.id, status: .rejected, reason: .pairingRejected, source: "lan_auth_rejected")
        }
        // Stop the transport: the auto-reconnect loop already latched its
        // rejected flag (no more LAN attempts), and a dead identity has
        // nothing to keep alive on the relay side either.
        transport?.stop()
        transport = nil
    }

}
