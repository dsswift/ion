import Foundation
import CryptoKit

// MARK: - Inactive-desktop presence polling

// Extracted from SessionViewModel.swift when per-pairing OIDC credentials were
// introduced: resolving a bearer per device is more than a one-liner, and the
// host file is at its size cap.

extension SessionViewModel {

    /// Poll relay channel status for all non-active paired devices.
    ///
    /// Each pairing is polled with **its own** credential. In OIDC mode that is
    /// a token minted for that desktop's tenant, resolved silently: this runs
    /// unprompted when the desktop picker appears, so it must never be able to
    /// raise a sign-in sheet. A pairing with no silent credential available is
    /// reported as unknown status rather than polled with a wrong token.
    ///
    /// Before this, every device was polled with `device.relayAPIKey`, which in
    /// OIDC mode holds a stale desktop-minted bootstrap token (often empty) —
    /// so presence for OIDC pairings was answered by an unauthorized request
    /// and read as offline.
    func pollDeviceStatus() {
        let activeId = activeDevice?.id
        let devices = pairedDevices.filter { $0.id != activeId }
        guard !devices.isEmpty else { return }
        let fallbackRelayURL = relayURL
        let fallbackAPIKey = relayAPIKey

        Task { [weak self] in
            guard let self else { return }
            for device in devices {
                let relayUrl = device.relayURL ?? fallbackRelayURL
                let channelId = E2ECrypto.deriveChannelId(
                    sharedSecret: SymmetricKey(data: device.sharedSecret)
                )
                let bearer = await self.silentBearer(for: device, fallbackAPIKey: fallbackAPIKey)
                let online = await PeerStatusPoller.checkDesktopOnline(
                    relayURL: relayUrl, bearer: bearer, channelId: channelId
                )
                await MainActor.run {
                    self.deviceOnlineStatus[device.id] = online
                }
            }
        }
    }

    /// A bearer token for this pairing that can be obtained without any UI.
    ///
    /// OIDC pairings resolve through their own token manager (cache, then silent
    /// refresh). `existing(deviceId:)` is used rather than `manager(for:)` so a
    /// background poll never *creates* a manager as a side effect. PSK pairings
    /// use their stored key, which is what the relay expects for them.
    func silentBearer(for device: PairedDevice, fallbackAPIKey: String) async -> String? {
        guard device.usesOIDC else {
            let key = device.relayAPIKey ?? fallbackAPIKey
            return key.isEmpty ? nil : key
        }
        guard let manager = oidcRegistry.existing(deviceId: device.id) else {
            DiagnosticLog.log("peer status: no OIDC manager for pairing, reporting unknown", tag: "session.peerstatus", fields: [
                "device": String(device.id.prefix(8))
            ])
            return nil
        }
        let token = await manager.accessTokenIfAvailable()
        if token == nil {
            DiagnosticLog.log("peer status: no silent OIDC token for pairing, reporting unknown", tag: "session.peerstatus", fields: [
                "device": String(device.id.prefix(8))
            ])
        }
        return token
    }
}
