import Foundation

// MARK: - Outbound

extension TransportManager {

    /// Send a command to the Ion desktop via the preferred transport.
    ///
    /// Uses LAN when connected, otherwise falls back to relay. The command is
    /// JSON-encoded, encrypted, wrapped in a `WireMessage` envelope, and sent
    /// as binary data over the active WebSocket.
    func send(_ command: RemoteCommand) async throws {
        let payload = try JSONEncoder().encode(command)
        let wire = try buildWireMessage(payload: payload)
        let wireData = try JSONEncoder().encode(wire)

        if state == .lanPreferred, lan.isConnected {
            try await lan.send(data: wireData)
        } else if let relay, relay.isConnected {
            try await relay.send(data: wireData)
        } else {
            throw TransportError.noTransportAvailable
        }
    }

    // MARK: - LAN Auth Handshake

    /// Perform challenge-response authentication on the active LAN connection.
    /// Waits for AuthChallenge from Ion, proves we hold the shared secret,
    /// and waits for AuthResult.
    func performLANAuth() async -> Bool {
        // Wait for the first message (should be AuthChallenge).
        for await data in lan.messages {
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { continue }

            if type == "auth_challenge", let nonceB64 = json["nonce"] as? String {
                guard let nonceData = Data(base64Encoded: nonceB64) else { return false }
                let proof = E2ECrypto.createAuthProof(nonce: nonceData, sharedSecret: sharedKey)

                // Send auth_response as a WireMessage with payload.
                let authResponse: [String: Any] = [
                    "type": "auth_response",
                    "deviceId": deviceId ?? "",
                    "proof": proof.base64EncodedString(),
                ]
                if let responseData = try? JSONSerialization.data(withJSONObject: authResponse),
                   let payloadStr = String(data: responseData, encoding: .utf8) {
                    let wireMsg = WireMessage(seq: 0, ts: Date().timeIntervalSince1970 * 1000, payload: payloadStr)
                    if let wireData = try? JSONEncoder().encode(wireMsg) {
                        try? await lan.send(data: wireData)
                    }
                }

                // Wait for AuthResult.
                for await resultData in lan.messages {
                    guard let resultJson = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any],
                          let rType = resultJson["type"] as? String else { continue }

                    if rType == "auth_result" {
                        return resultJson["success"] as? Bool == true
                    }
                    // Also check for WireMessage wrapping an auth_result
                    if let payload = resultJson["payload"] as? String,
                       let inner = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
                       inner["type"] as? String == "auth_result" {
                        return inner["success"] as? Bool == true
                    }
                }
                return false
            }
            return false
        }
        return false
    }

    // MARK: - Wire message builder

    func buildWireMessage(payload: Data) throws -> WireMessage {
        seq += 1

        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: payload, key: sharedKey)
        return WireMessage(
            seq: seq,
            ts: Date().timeIntervalSince1970 * 1000,
            payload: nil,
            nonce: nonce.base64EncodedString(),
            ciphertext: ciphertext.base64EncodedString(),
            deviceId: deviceId
        )
    }
}
