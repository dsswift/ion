import Foundation
import SwiftUI
import CryptoKit

// MARK: - Relay pairing (Ion Studio Server, child 19)

/// Errors specific to the relay-pairing flow (`PairingView`'s "Pair over
/// relay"). Distinct from `PairingError` (LAN pairing) because "every relay
/// URL refused the upgrade" and "the pairing payload already expired" have
/// no LAN counterpart.
enum RelayPairingError: Error, LocalizedError {
    case expiredPayload
    case noReachableRelay
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .expiredPayload: return "This pairing code has expired. Generate a new one."
        case .noReachableRelay: return "Couldn't reach any of the relay servers in the pairing code."
        case .invalidResponse: return "The server sent an unexpected pairing response."
        }
    }
}

extension SessionViewModel {

    /// Sign in for `payload.issuer`/`audience`/`scope`, open `channelId` on
    /// the first reachable relay in `payload.relayUrls`, and run the same
    /// `E2ECrypto` DH handshake LAN pairing runs — just carried over a relay
    /// WebSocket channel instead of the desktop's local `/pair` endpoint.
    ///
    /// On success, the paired device is configured exactly like an existing
    /// OIDC relay pairing (`relayAuthMode = "oidc"` + the resolved issuer/
    /// audience/scope): `connect()`'s existing `oidcCredentialClosures` path
    /// already knows how to keep that token fresh, so relay-pairing needs no
    /// parallel reconnect machinery — it only needs a different bootstrap.
    func pairOverRelay(payload: RelayPairingPayload) async -> Bool {
        guard !payload.isExpired else {
            await MainActor.run { self.pairingState = .failed(RelayPairingError.expiredPayload) }
            return false
        }
        await MainActor.run { self.pairingState = .connecting(hostName: "relay") }

        // Temporary manager: signs in interactively (this device has never
        // talked to this issuer for this channel before, so there is no
        // Keychain refresh token to silently refresh) and stores its refresh
        // token under a channel-scoped Keychain key. `addOrUpdateDevice`
        // below persists a PairedDevice whose `id` reuses the DERIVED
        // channel id from the DH handshake, not this temporary one, so the
        // registry looks the manager up fresh via `oidcRegistry.manager(for:)`
        // once the real device exists.
        let bootstrapDeviceId = "relay-pairing:\(payload.channelId)"
        let bootstrapManager = OIDCTokenManager(
            clientId: payload.audience,
            issuer: payload.issuer,
            scope: payload.scope,
            deviceId: bootstrapDeviceId
        )

        let token: String
        do {
            token = try await bootstrapManager.forceInteractiveReauth()
        } catch {
            DiagnosticLog.log("relay pairing sign-in failed", tag: "pairing.relay", level: .error, fields: [
                "error": error.localizedDescription
            ])
            await MainActor.run { self.pairingState = .failed(error) }
            return false
        }

        await MainActor.run { self.pairingState = .exchangingKeys }

        guard let (reachableURL, ws, factory) = await Self.connectFirstReachableRelay(
            relayUrls: payload.relayUrls,
            channelId: payload.channelId,
            bearer: token
        ) else {
            DiagnosticLog.log("relay pairing: no relay reachable", tag: "pairing.relay", level: .error, fields: [
                "relay_count": String(payload.relayUrls.count)
            ])
            await MainActor.run { self.pairingState = .failed(RelayPairingError.noReachableRelay) }
            return false
        }

        do {
            let keyPair = E2ECrypto.generateKeyPair()
            let publicKeyB64 = keyPair.publicKey.rawRepresentation.base64EncodedString()
            let deviceName = await UIDevice.current.name

            let pairingRequest: [String: Any] = [
                "type": "pair_request",
                "code": "",
                "publicKey": publicKeyB64,
                "deviceName": deviceName,
                "mobileDeviceId": MobileInstallationIdentity.id(),
            ]
            let requestData = try JSONSerialization.data(withJSONObject: pairingRequest)
            try await ws.send(.string(String(data: requestData, encoding: .utf8)!))

            let response = try await ws.receive()
            let responseData: Data
            switch response {
            case .string(let text): responseData = text.data(using: .utf8) ?? Data()
            case .data(let data): responseData = data
            @unknown default: throw RelayPairingError.invalidResponse
            }

            guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                  let peerPublicKeyB64 = json["publicKey"] as? String,
                  let peerPublicKeyData = Data(base64Encoded: peerPublicKeyB64) else {
                throw RelayPairingError.invalidResponse
            }

            let peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKeyData)
            let sharedKey = try E2ECrypto.deriveSharedSecret(privateKey: keyPair, peerPublicKey: peerPublicKey)
            let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)
            let sharedKeyData = sharedKey.withUnsafeBytes { Data($0) }
            let desktopId = json["desktopId"] as? String
            let name = (json["desktopName"] as? String) ?? "Ion Studio Server"

            ws.cancel(with: .normalClosure, reason: nil)
            factory.invalidateAndCancel()

            var device = PairedDevice(
                id: channelId.prefix(16).description,
                name: name,
                pairedAt: Date(),
                lastSeen: nil,
                channelId: channelId,
                sharedSecret: sharedKeyData,
                relayURL: reachableURL.absoluteString,
                relayAPIKey: ""
            )
            device.desktopId = desktopId
            device.pairedVia = "relay"
            device.relayUrls = payload.relayUrls
            device.relayAuthMode = "oidc"
            device.relayOidcIssuer = payload.issuer
            device.relayOidcAudience = payload.audience
            device.relayOidcRequiredScope = payload.scope
            device.relayOidcClientId = payload.audience

            await MainActor.run {
                self.addOrUpdateDevice(device)
                self.relayURL = reachableURL.absoluteString
                self.relayAPIKey = ""
                self.savePairedDevices()
                self.activeDeviceId = device.id
                self.pairingState = .paired
                self.connect()
            }
            DiagnosticLog.log("relay pairing succeeded", tag: "pairing.relay", fields: [
                "device": String(device.id.prefix(8)),
                "relay": reachableURL.host(percentEncoded: false) ?? "unknown"
            ])
            return true
        } catch {
            ws.cancel(with: .normalClosure, reason: nil)
            factory.invalidateAndCancel()
            DiagnosticLog.log("relay pairing DH handshake failed", tag: "pairing.relay", level: .error, fields: [
                "error": error.localizedDescription
            ])
            await MainActor.run { self.pairingState = .failed(error) }
            return false
        }
    }

    /// Try each relay URL in order; return the first that accepts the
    /// WebSocket upgrade (proven by a successful `resume()` + no immediate
    /// close). Mirrors the Studio relay socket's URL construction so the
    /// pairing channel and the eventual data channel are dialed identically.
    private static func connectFirstReachableRelay(
        relayUrls: [String],
        channelId: String,
        bearer: String
    ) async -> (URL, URLSessionWebSocketTask, URLSessionRelayWebSocketTaskFactory)? {
        for raw in relayUrls {
            guard let base = URL(string: raw) else { continue }
            var components = URLComponents()
            switch base.scheme {
            case "https", "wss": components.scheme = "wss"
            default: components.scheme = "ws"
            }
            components.host = base.host(percentEncoded: false)
            components.port = base.port
            let basePath = base.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            components.path = basePath.isEmpty
                ? "/v1/channel/\(channelId)"
                : "/\(basePath)/v1/channel/\(channelId)"
            components.queryItems = [URLQueryItem(name: "role", value: "mobile")]
            guard let url = components.url else { continue }

            var request = URLRequest(url: url)
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 10

            let factory = URLSessionRelayWebSocketTaskFactory()
            let task = factory.makeTask(request: request)
            guard let wsTask = task as? URLSessionWebSocketTask else {
                factory.invalidateAndCancel()
                continue
            }
            wsTask.resume()

            // Prove the upgrade succeeded with one receive attempt bounded by
            // a short deadline — an unreachable/refusing relay either errors
            // immediately or hangs, and pairing must move to the next URL
            // rather than wait out the full connect timeout for every entry.
            let reachable = await Self.probeUpgrade(wsTask)
            if reachable {
                return (url, wsTask, factory)
            }
            wsTask.cancel(with: .goingAway, reason: nil)
            factory.invalidateAndCancel()
        }
        return nil
    }

    private static func probeUpgrade(_ task: URLSessionWebSocketTask) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                do {
                    try await task.sendPing()
                    return true
                } catch {
                    return false
                }
            }
            group.addTask {
                // Timeout arm of the race: a cancelled sleep only means the other arm already won.
                // swiftlint:disable:next silent_try_optional
                try? await Task.sleep(for: .seconds(5))
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }
}

private extension URLSessionWebSocketTask {
    func sendPing() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }
}
