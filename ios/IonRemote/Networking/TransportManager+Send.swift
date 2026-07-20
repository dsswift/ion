import Foundation

// MARK: - Outbound

extension TransportManager {

    /// Send a command to the Ion desktop via the preferred transport.
    ///
    /// Uses LAN when connected, otherwise falls back to relay. The command is
    /// JSON-encoded, encrypted, wrapped in a `WireMessage` envelope, and sent
    /// as binary data over the active WebSocket.
    ///
    /// Seq allocation and the socket write happen as ONE atomic unit on the
    /// strict-FIFO `outboundQueue`, so wire order always equals seq order.
    /// Concurrent callers used to allocate seqs under a lock but then race the
    /// socket writes that followed further awaits, letting a later seq hit the
    /// wire first. (The desktop's dedup now tolerates reorder, but iOS still
    /// writes in seq order — reorder is a defect, not a supported shape.)
    func send(_ command: RemoteCommand) async throws {
        let payload = try JSONEncoder().encode(command)
        try await outboundQueue.enqueue { [self] in
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
    }

    // MARK: - LAN Auth Handshake

    /// Perform challenge-response authentication on the active LAN connection.
    /// Waits for AuthChallenge from Ion, proves we hold the shared secret,
    /// and waits for AuthResult. Races against an 8-second timeout.
    ///
    /// Returns the STREAM outcome only: `.rejected` requires an explicit
    /// `auth_result success=false`; the timeout and every verdict-less stream
    /// end are `.transient`. `startLANWithAuth` combines this with the
    /// socket's close code (`LANAuthOutcome.resolve`) for the final verdict.
    func performLANAuth() async -> LANAuthOutcome {
        await withTaskGroup(of: LANAuthOutcome.self) { [weak self] group in
            guard let self else { return .transient }
            group.addTask { await self.performLANAuthCore() }
            group.addTask { [weak self] in
                try? await Task.sleep(for: .seconds(8))
                guard !Task.isCancelled else { return .transient }
                DiagnosticLog.log("AUTH: timeout fired, disconnecting LAN")
                self?.lan.disconnect()
                // A timeout is NOT a rejection — the desktop never answered.
                return .transient
            }
            let result = await group.next() ?? .transient
            group.cancelAll()
            return result
        }
    }

    private func performLANAuthCore() async -> LANAuthOutcome {
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
                    // Protocol anomaly, not a verdict — the desktop never
                    // refused this identity.
                    return .transient
                }

                DiagnosticLog.log("AUTH: challenge received")
                guard let nonceData = Data(base64Encoded: nonceB64) else { return .transient }
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
                        do {
                            try await lan.send(data: wireData)
                        } catch {
                            // Auth-response send failure silently stalls the LAN
                            // handshake until the 8s timeout; log so it's visible.
                            DiagnosticLog.log("AUTH-CORE: auth response send failed", tag: "transport.send", level: .error, fields: [
                                "error": String(describing: error),
                            ])
                        }
                    } else {
                        DiagnosticLog.log("AUTH-CORE: wire encode failed for auth response", tag: "transport.send", level: .error)
                    }
                } else {
                    DiagnosticLog.log("AUTH-CORE: auth response serialization failed", tag: "transport.send", level: .error)
                }
                awaitingResult = true
                DiagnosticLog.log("AUTH-CORE: sent response, awaiting result")
            } else {
                // Phase 2: waiting for auth_result (bare or WireMessage-wrapped;
                // parsing lives in LANAuthOutcome.verdict so tests can pin it
                // with real frames). An explicit success=false is the ONLY
                // stream-level definitive rejection.
                if let verdict = LANAuthOutcome.verdict(fromAuthFrame: json) {
                    DiagnosticLog.log("lan auth result received", tag: "transport.auth", fields: [
                        "success": String(verdict == .success)
                    ])
                    return verdict
                }
                DiagnosticLog.log("lan auth unexpected type in phase2", tag: "transport.auth", level: .warn, fields: [
                    "type": type
                ])
            }
        }
        // Stream ended without an auth_result — no verdict from the desktop
        // (socket dropped, cooldown close, desktop died mid-handshake).
        DiagnosticLog.log("AUTH-CORE: for-await ended (stream finished)")
        return .transient
    }

    // MARK: - Wire message builder

    func buildWireMessage(payload: Data) throws -> WireMessage {
        let currentSeq = _seqLock.withLock { state -> UInt64 in
            state += 1
            return state
        }

        let (nonce, ciphertext) = try E2ECrypto.encrypt(plaintext: payload, key: sharedKey)
        // Every outbound frame carries this instance's generation id. The
        // desktop keys its inbound dedup to it: a newer epoch (new
        // TransportManager after app restart / re-pair) resets its dedup; a
        // stale epoch marks a late frame from a dead instance. The seq counter
        // itself is never reset — the epoch identifies the generation.
        return WireMessage(
            seq: currentSeq,
            ts: Date().timeIntervalSince1970 * 1000,
            payload: nil,
            nonce: nonce.base64EncodedString(),
            ciphertext: ciphertext.base64EncodedString(),
            deviceId: deviceId,
            epoch: outboundEpoch
        )
    }
}
