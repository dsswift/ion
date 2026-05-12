import Foundation
import SwiftUI
import CryptoKit

// MARK: - Pairing

extension SessionViewModel {

    func startPairing() {
        pairingState = .discovering
        pairingBrowser.startBrowsing()
    }

    func pairWithHost(_ host: DiscoveredHost) {
        pairingState = .connecting(hostName: host.name)

        Task {
            _ = E2ECrypto.generateKeyPair()
            await MainActor.run {
                self.pairingState = .exchangingKeys
            }
            await MainActor.run {
                self.pairingState = .configuringRelay
            }
        }
    }

    func completePairing(relayURL: String, relayAPIKey: String) {
        self.relayURL = relayURL
        self.relayAPIKey = relayAPIKey

        if let device = activeDevice,
           let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            pairedDevices[idx].relayURL = relayURL
            pairedDevices[idx].relayAPIKey = relayAPIKey
            savePairedDevices()
        }

        pairingState = .paired
        connect()
    }

    /// Pair directly with an Ion instance over LAN using a 6-digit pairing code.
    func pairWithCode(host: String, port: UInt16, name: String, code: String) {
        pairingState = .connecting(hostName: name)

        Task {
            do {
                guard let url = URL(string: "ws://\(host):\(port)/pair") else {
                    throw PairingError.invalidResponse
                }
                var request = URLRequest(url: url)
                request.timeoutInterval = 10

                let session = URLSession(configuration: .default)
                let ws = session.webSocketTask(with: request)
                ws.resume()

                let keyPair = E2ECrypto.generateKeyPair()
                let publicKeyB64 = keyPair.publicKey.rawRepresentation.base64EncodedString()

                let deviceName = await UIDevice.current.name
                let pairingRequest: [String: String] = [
                    "type": "pair_request",
                    "code": code,
                    "publicKey": publicKeyB64,
                    "deviceName": deviceName,
                ]
                let requestData = try JSONSerialization.data(withJSONObject: pairingRequest)
                try await ws.send(.string(String(data: requestData, encoding: .utf8)!))

                await MainActor.run {
                    self.pairingState = .exchangingKeys
                }

                let response = try await ws.receive()
                let responseData: Data
                switch response {
                case .string(let text):
                    responseData = text.data(using: .utf8) ?? Data()
                case .data(let data):
                    responseData = data
                @unknown default:
                    throw PairingError.invalidResponse
                }

                guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                      let peerPublicKeyB64 = json["publicKey"] as? String,
                      let peerPublicKeyData = Data(base64Encoded: peerPublicKeyB64) else {
                    throw PairingError.invalidResponse
                }

                let peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKeyData)
                let sharedKey = try E2ECrypto.deriveSharedSecret(privateKey: keyPair, peerPublicKey: peerPublicKey)
                let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)
                let sharedKeyData = sharedKey.withUnsafeBytes { Data($0) }

                let relayUrl = (json["relayUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? "ws://\(host):\(port)"
                let relayApiKey = (json["relayApiKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? "lan-direct"

                let device = PairedDevice(
                    id: channelId.prefix(16).description,
                    name: name,
                    pairedAt: Date(),
                    lastSeen: nil,
                    channelId: channelId,
                    sharedSecret: sharedKeyData,
                    relayURL: relayUrl,
                    relayAPIKey: relayApiKey
                )

                ws.cancel(with: .normalClosure, reason: nil)
                session.invalidateAndCancel()

                await MainActor.run {
                    self.addOrUpdateDevice(device)
                    self.relayURL = relayUrl
                    self.relayAPIKey = relayApiKey
                    self.savePairedDevices()
                    self.activeDeviceId = device.id
                    self.pairingState = .paired
                    self.connectLAN(host: host, port: port)
                }
            } catch {
                await MainActor.run {
                    self.pairingState = .failed(error)
                }
            }
        }
    }

    /// Attempt a codeless recovery re-pair with an Ion instance that already
    /// has this device in its paired list (e.g. after a simulator reinstall
    /// wiped the Keychain). Returns true if the desktop accepted the recovery.
    func recoveryPair(host: String, port: UInt16, name: String) async -> Bool {
        await MainActor.run { pairingState = .connecting(hostName: name) }

        do {
            guard let url = URL(string: "ws://\(host):\(port)/pair") else { return false }
            var request = URLRequest(url: url)
            request.timeoutInterval = 5

            let session = URLSession(configuration: .default)
            let ws = session.webSocketTask(with: request)
            ws.resume()

            let keyPair = E2ECrypto.generateKeyPair()
            let publicKeyB64 = keyPair.publicKey.rawRepresentation.base64EncodedString()

            let deviceName = await UIDevice.current.name
            let pairingRequest: [String: Any] = [
                "type": "pair_request",
                "code": "",
                "publicKey": publicKeyB64,
                "deviceName": deviceName,
                "recovery": true,
            ]
            let requestData = try JSONSerialization.data(withJSONObject: pairingRequest)
            try await ws.send(.string(String(data: requestData, encoding: .utf8)!))

            await MainActor.run { self.pairingState = .exchangingKeys }

            let response = try await ws.receive()
            let responseData: Data
            switch response {
            case .string(let text):
                responseData = text.data(using: .utf8) ?? Data()
            case .data(let data):
                responseData = data
            @unknown default:
                return false
            }

            guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                  let peerPublicKeyB64 = json["publicKey"] as? String,
                  let peerPublicKeyData = Data(base64Encoded: peerPublicKeyB64) else {
                ws.cancel(with: .normalClosure, reason: nil)
                session.invalidateAndCancel()
                return false
            }

            let peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKeyData)
            let sharedKey = try E2ECrypto.deriveSharedSecret(privateKey: keyPair, peerPublicKey: peerPublicKey)
            let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)
            let sharedKeyData = sharedKey.withUnsafeBytes { Data($0) }

            let relayUrl = (json["relayUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? "ws://\(host):\(port)"
            let relayApiKey = (json["relayApiKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? "lan-direct"

            let device = PairedDevice(
                id: channelId.prefix(16).description,
                name: name,
                pairedAt: Date(),
                lastSeen: nil,
                channelId: channelId,
                sharedSecret: sharedKeyData,
                relayURL: relayUrl,
                relayAPIKey: relayApiKey
            )

            ws.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()

            await MainActor.run {
                self.addOrUpdateDevice(device)
                self.relayURL = relayUrl
                self.relayAPIKey = relayApiKey
                self.savePairedDevices()
                self.activeDeviceId = device.id
                self.pairingState = .paired
                self.connectLAN(host: host, port: port)
            }
            return true
        } catch {
            return false
        }
    }

    func cancelPairing() {
        pairingBrowser.stopBrowsing()
        pairingState = .idle
    }

    // MARK: - Helpers

    /// Add a new device or update an existing one (dedup by id).
    private func addOrUpdateDevice(_ device: PairedDevice) {
        if let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            pairedDevices[idx] = device
        } else {
            pairedDevices.append(device)
        }
    }
}
