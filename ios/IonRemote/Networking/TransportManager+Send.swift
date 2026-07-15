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
    /// and waits for AuthResult. Races against an 8-second timeout.
    func performLANAuth() async -> Bool {
        await withTaskGroup(of: Bool.self) { [weak self] group in
            guard let self else { return false }
            group.addTask { await self.performLANAuthCore() }
            group.addTask { [weak self] in
                try? await Task.sleep(for: .seconds(8))
                guard !Task.isCancelled else { return false }
                DiagnosticLog.log("AUTH: timeout fired, disconnecting LAN")
                self?.lan.disconnect()
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }

    private func performLANAuthCore() async -> Bool {
        // IMPORTANT: AsyncStream is single-consumer. We must use exactly ONE
        // `for await` loop here so that `startLANListener` can later create
        // the next (and only) iterator on the same stream. Nested `for await`
        // loops on the same stream create multiple iterators which corrupts
        // the stream state and causes the listener's iterator to terminate
        // immediately.
        var awaitingResult = false
        DiagnosticLog.log("AUTH-CORE: entering for-await on lan.messages")

        for await data in lan.messages {
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { continue }

            if !awaitingResult {
                // Phase 1: waiting for auth_challenge
                guard type == "auth_challenge",
                      let nonceB64 = json["nonce"] as? String else {
                    DiagnosticLog.log("lan auth unexpected type in phase1", tag: "transport.auth", level: .warn, fields: [
                        "type": type
                    ])
                    return false
                }

                DiagnosticLog.log("AUTH: challenge received")
                guard let nonceData = Data(base64Encoded: nonceB64) else { return false }
                let proof = E2ECrypto.createAuthProof(nonce: nonceData, sharedSecret: sharedKey)

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
                awaitingResult = true
                DiagnosticLog.log("AUTH-CORE: sent response, awaiting result")
            } else {
                // Phase 2: waiting for auth_result
                if type == "auth_result" {
                    let ok = json["success"] as? Bool == true
                    DiagnosticLog.log("lan auth result received", tag: "transport.auth", fields: [
                        "success": String(ok)
                    ])
                    return ok
                }
                // Also check for WireMessage wrapping an auth_result
                if let payload = json["payload"] as? String,
                   let inner = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
                   inner["type"] as? String == "auth_result" {
                    let ok = inner["success"] as? Bool == true
                    DiagnosticLog.log("lan auth result received (wire)", tag: "transport.auth", fields: [
                        "success": String(ok)
                    ])
                    return ok
                }
                DiagnosticLog.log("lan auth unexpected type in phase2", tag: "transport.auth", level: .warn, fields: [
                    "type": type
                ])
            }
        }
        DiagnosticLog.log("AUTH-CORE: for-await ended (stream finished)")
        return false
    }

    // MARK: - Wire message builder

    func buildWireMessage(payload: Data) throws -> WireMessage {
        let currentSeq = _seqLock.withLock { state -> UInt64 in
            state += 1
            return state
        }

        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: payload, key: sharedKey)
        return WireMessage(
            seq: currentSeq,
            ts: Date().timeIntervalSince1970 * 1000,
            payload: nil,
            nonce: nonce.base64EncodedString(),
            ciphertext: ciphertext.base64EncodedString(),
            deviceId: deviceId
        )
    }
}
