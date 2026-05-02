import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "transport")

// MARK: - Inbound

extension TransportManager {

    // MARK: - Relay listener

    func startRelayListener() {
        guard let relay else { return }
        relayListenTask?.cancel()
        relayListenTask = Task { [weak self] in
            guard let self else { return }
            for await data in relay.messages {
                guard !Task.isCancelled else { break }
                // In lanPreferred mode, still check for relay control frames
                // but skip data messages.
                self.handleIncomingData(data, isRelay: true)
            }
        }
    }

    func startRelayStateObservation() {
        guard let relay else { return }
        relayStateTask?.cancel()
        relayStateTask = Task { [weak self] in
            var wasConnected = false
            while !Task.isCancelled {
                guard let self else { break }
                let connected = relay.isConnected
                if connected != wasConnected {
                    wasConnected = connected
                    if connected {
                        // Relay just connected — send sync so the desktop
                        // knows we're here and replies with a snapshot.
                        do {
                            try await self.send(.sync)
                            print("[Ion] relay connected, sent sync")
                        } catch {
                            print("[Ion] relay connected, failed to send sync: \(error)")
                        }
                    }
                    self.updateState()
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    // MARK: - LAN listener

    func startLANListener() {
        lanListenTask?.cancel()
        lanListenTask = Task { [weak self] in
            guard let self else { return }
            for await data in self.lan.messages {
                guard !Task.isCancelled else { break }
                self.handleIncomingData(data, isRelay: false)
            }
            // LAN stream ended -- the WebSocket closed.
            // Emit peerDisconnected if we have no relay fallback.
            if self.relay == nil || !(self.relay?.isConnected ?? false) {
                self.eventContinuation.yield(.peerDisconnected)
            }
            self.updateState()
        }
    }

    func startLANStateObservation() {
        lanStateTask?.cancel()
        lanStateTask = Task { [weak self] in
            var wasConnected = false
            while !Task.isCancelled {
                guard let self else { break }
                let connected = self.lan.isConnected
                if connected != wasConnected {
                    wasConnected = connected
                    if !connected {
                        self.updateState()
                    }
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    // MARK: - Wire message dispatch

    func handleIncomingData(_ data: Data, isRelay: Bool) {
        // Check for relay control frames FIRST — they're bare JSON without a
        // WireMessage envelope (no seq field), so WireMessage decode would fail.
        if isRelay,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let type = json["type"] as? String, type.hasPrefix("relay:") {
            if type == "relay:peer-disconnected" {
                // The relay told us the desktop disconnected. Start grace
                // period with force=true because the relay WebSocket itself
                // is still connected — the *peer* is gone.
                startDisconnectGracePeriod(force: true)
            } else if type == "relay:peer-reconnected" {
                cancelDisconnectGracePeriod()
                // Peer is back — reset dedup so fresh seq=1 messages aren't dropped.
                lastReceivedSeq = 0
                updateState()
            }
            return
        }

        guard let wire = try? JSONDecoder().decode(WireMessage.self, from: data) else {
            return
        }

        // Check for auth_result (late revocation during session).
        if let payloadStr = wire.payload,
           let json = try? JSONSerialization.jsonObject(with: Data(payloadStr.utf8)) as? [String: Any],
           let type = json["type"] as? String, type == "auth_result" {
            if json["success"] as? Bool == false {
                eventContinuation.yield(.peerDisconnected)
            }
            return
        }

        // Dedup: drop if seq <= lastReceivedSeq
        if wire.seq > 0, wire.seq <= lastReceivedSeq {
            return
        }
        if wire.seq > 0 {
            lastReceivedSeq = wire.seq
        }

        // In lanPreferred mode, skip relay data messages (control frames handled above).
        if isRelay && state == .lanPreferred { return }

        // Decrypt -- encryption is required for data messages.
        guard let ciphertextB64 = wire.ciphertext, let nonceB64 = wire.nonce,
              let ciphertext = Data(base64Encoded: ciphertextB64),
              let nonce = Data(base64Encoded: nonceB64) else {
            ionLog.warning("wire message seq=\(wire.seq) missing ciphertext/nonce fields")
            return
        }

        guard let payloadData = try? E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: sharedKey) else {
            ionLog.warning("decrypt failed for seq=\(wire.seq) — possible key mismatch")
            return
        }

        // Check for heartbeat: track but don't surface to the app
        if let json = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
           let type = json["type"] as? String, type == "heartbeat" {
            return
        }

        let event: RemoteEvent
        do {
            event = try JSONDecoder().decode(RemoteEvent.self, from: payloadData)
        } catch {
            // Log decode failures so we can diagnose dropped events
            let typeHint = (try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any])?["type"] as? String ?? "unknown"
            ionLog.error("Failed to decode event type=\(typeHint): \(error)")
            return
        }

        eventContinuation.yield(event)
    }
}
