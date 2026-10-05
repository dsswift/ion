import Foundation
import UIKit

// MARK: - Studio wire
//
// Connecting and pairing over the Studio wire, which is the only wire this app
// runs on.

extension SessionViewModel {

    /// `PairedDevice.pairedVia` for a pairing made with `POST /auth/pair`. The
    /// server knows such a phone only as a Studio wire client, so it always
    /// connects on that wire.
    static let pairedViaStudio = "studio"

    // MARK: - Connect

    /// Builds and starts a Studio transport for `device`.
    ///
    /// A pairing with no stored Studio credential cannot connect at all: there
    /// is no second wire to fall back to. The session goes honestly
    /// disconnected so the disconnected view's retry and the user's re-pair
    /// are what recover it.
    func connectOverStudioWire(device: PairedDevice, state: ConnectionState) {
        guard let record = studioRecord(for: device) else {
            DiagnosticLog.log("studio connect: no studio credential for this pairing", tag: "session.lifecycle", level: .error, fields: [
                "device": String(device.id.prefix(8)), "paired_via": device.pairedVia ?? "unknown"
            ])
            connectionState = .disconnected
            return
        }
        DiagnosticLog.log("connect studio wire", tag: "session.lifecycle", fields: [
            "device": String(device.id.prefix(8)), "client_id": record.clientId,
            "has_url": String(record.url != nil), "relay_count": String(record.relays.count)
        ])
        restoreCachedLayout(for: device.id)

        let deviceId = device.id
        var inputs = TransportFactory.StudioInputs(record: record, deviceId: device.id)
        // The bench verbs name a bench by its directory; this client learns
        // each one from the worktree projections it already receives.
        let benchPaths = worktreeUI.benchPaths
        inputs.mapping = StudioTransportCommandMapping(benchPath: { repoPath, sourceBranch in
            benchPaths.path(repoPath: repoPath, sourceBranch: sourceBranch)
        })
        // Resolved per join, not now: a relay that names its own issuers
        // configures this pairing's sign-in from the relay the first time it
        // is needed (`relayToken`).
        inputs.oidcToken = { [weak self] relay in
            guard let self else { throw StudioRouteError.routeReleased }
            return try await self.relayToken(for: relay, deviceId: deviceId)
        }
        let studio = TransportFactory.makeStudioTransport(inputs)
        transport = studio
        connectionState = state
        Task { await studio.start() }
        startListening()
    }

    /// The stored Studio record for a paired device: the one migrated from it,
    /// or the one whose id its secret derives.
    func studioRecord(for device: PairedDevice) -> StudioServerRecord? {
        let records: [StudioServerRecord]
        do {
            records = try StudioServerKeychainStore().load()
        } catch {
            DiagnosticLog.log("studio connect: stored servers unreadable", tag: "session.lifecycle", level: .error, fields: [
                "error": String(describing: error)
            ])
            return nil
        }
        return StudioServerRecord.record(for: device, in: records)
    }

    // MARK: - Pair

    /// Pairs with a server by its one-time code (`POST /auth/pair`), stores the
    /// credential, and connects.
    func pairWithStudioServer(serverURL: URL, code: String, name: String, machineId: String?) {
        pairingState = .connecting(hostName: name)
        Task { @MainActor [weak self] in
            do {
                let paired = try await StudioPairing.pair(StudioPairing.Request(
                    serverURL: serverURL, code: code, label: UIDevice.current.name, deviceId: MobileInstallationIdentity.id()
                ))
                self?.completeStudioPairing(paired, fallbackName: name, machineId: machineId)
            } catch {
                DiagnosticLog.log("studio pairing failed", tag: "pairing", level: .warn, fields: [
                    "host": serverURL.host(percentEncoded: false) ?? "unknown", "error": error.localizedDescription
                ])
                self?.pairingState = .failed(error)
            }
        }
    }

    /// Pairs from a scanned, pasted, or opened `ion-studio://pair` link.
    func pairWithStudioLink(_ text: String) {
        let link: StudioPairingLink
        do {
            link = try StudioPairingLink.parse(text)
        } catch {
            DiagnosticLog.log("studio pairing link rejected", tag: "pairing", level: .warn, fields: [
                "error": error.localizedDescription
            ])
            pairingState = .failed(error)
            return
        }
        guard let serverURL = link.serverURL else {
            // Pairing through the relay channel the link names is not built on
            // this client, so say what does work instead of attempting it.
            DiagnosticLog.log("studio pairing link names only a relay channel", tag: "pairing", level: .warn, fields: [
                "has_relay": String(link.relay != nil)
            ])
            pairingState = .failed(StudioPairingLinkError.needsLocalNetwork)
            return
        }
        DiagnosticLog.log("pairing from a studio link", tag: "pairing", fields: [
            "host": serverURL.host(percentEncoded: false) ?? "unknown", "has_relay": String(link.relay != nil)
        ])
        pairWithStudioServer(serverURL: serverURL, code: link.code, name: link.label ?? serverURL.host(percentEncoded: false) ?? "Ion Studio Server", machineId: nil)
    }

    @MainActor
    private func completeStudioPairing(_ paired: StudioPairing.Record, fallbackName: String, machineId: String?) {
        let label = paired.label.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
        let record = StudioServerRecord(
            clientId: paired.clientId, secret: paired.secret, url: paired.url,
            environmentId: paired.environmentId, machineId: machineId, label: label,
            relays: paired.relays, pairedDeviceId: paired.clientId
        )
        do {
            let store = StudioServerKeychainStore()
            var records = try store.load()
            records.removeAll { $0.clientId == record.clientId }
            records.append(record)
            try store.save(records)
        } catch {
            DiagnosticLog.log("studio pairing: could not store the credential", tag: "pairing", level: .error, fields: [
                "client_id": paired.clientId, "error": String(describing: error)
            ])
            pairingState = .failed(error)
            return
        }

        // The rest of the app lists and selects pairings as `PairedDevice`s,
        // so a Studio pairing gets one too, under the same id.
        var device = PairedDevice(
            id: paired.clientId, name: label, pairedAt: Date(), lastSeen: nil,
            channelId: E2ECrypto.deriveChannelId(sharedSecret: paired.key),
            sharedSecret: paired.secret, relayURL: nil, relayAPIKey: nil
        )
        device.pairedVia = Self.pairedViaStudio
        device.desktopId = machineId
        Self.applyRelay(paired.relays.first, to: &device)

        addOrUpdateDevice(device)
        savePairedDevices()
        // Pairing again with a server this phone already holds replaces the
        // older pairing instead of listing the server twice.
        for stale in dropSupersededPairings() {
            dropCredentials(deviceId: stale.deviceId, serverId: stale.clientId)
        }
        activeDeviceId = device.id
        pairingState = .paired
        DiagnosticLog.log("studio pairing complete", tag: "pairing", fields: [
            "client_id": paired.clientId, "relay_count": String(paired.relays.count), "scopes": paired.scopes.joined(separator: ",")
        ])
        connect()
    }

    /// Copies a server-reported relay into the paired-device fields the OIDC
    /// token manager and the settings screens read.
    private static func applyRelay(_ relay: StudioEnvironmentRelay?, to device: inout PairedDevice) {
        guard let relay else { return }
        device.relayURL = relay.url
        switch relay.auth {
        case .psk(let key):
            device.relayAuthMode = "psk"
            device.relayAPIKey = key
        case .oidc(let issuer, let audience, let scope):
            device.relayAuthMode = "oidc"
            device.relayAPIKey = ""
            device.relayOidcIssuer = issuer
            device.relayOidcAudience = audience
            device.relayOidcRequiredScope = scope
            device.relayOidcClientId = audience
        case .relayOIDC:
            // The relay names its own issuers; this client has no issuer to
            // sign in against until it reads them.
            device.relayAuthMode = "oidc"
            device.relayAPIKey = ""
        }
    }
}

enum StudioPairingLinkError: Error, LocalizedError, Equatable {
    case needsLocalNetwork

    var errorDescription: String? {
        switch self {
        case .needsLocalNetwork:
            return "This link pairs through a relay, which this app cannot do yet. Join the same network as the server and scan a new link."
        }
    }
}
