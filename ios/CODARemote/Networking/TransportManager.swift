import Foundation
import CryptoKit
import Network
import Observation

// MARK: - TransportState

/// Current transport connectivity state.
///
/// State machine:
/// - `disconnected` -> `relayOnly`: relay connects
/// - `disconnected` -> `lanPreferred`: LAN connects (LAN-only mode)
/// - `relayOnly` -> `lanPreferred`: LAN discovered and connected
/// - `lanPreferred` -> `relayOnly`: LAN lost, relay still connected
/// - any -> `disconnected`: all transports lost
enum TransportState: String {
    case disconnected
    case relayOnly
    case lanPreferred
}

// MARK: - TransportManager

/// Manages relay and LAN WebSocket connections, preferring LAN when available.
///
/// Wraps `RelayClient` and `LANClient` with E2E encryption via `E2ECrypto`.
/// Messages are encrypted before sending and decrypted after receiving so the
/// relay server never sees plaintext. When a LAN connection is available it
/// becomes the preferred transport; the relay stays connected as a fallback.
///
/// Supports two modes:
/// - **Relay + LAN**: relay is always connected, LAN discovered via Bonjour
/// - **LAN-only**: no relay, direct connection to a CODA instance with auth
@Observable
final class TransportManager {

    // MARK: - Public state

    private(set) var state: TransportState = .disconnected

    /// Merged stream of decrypted `RemoteEvent` values from whichever transport
    /// is currently active.
    let events: AsyncStream<RemoteEvent>

    // MARK: - Dependencies

    let relay: RelayClient?
    let lan: LANClient
    let bonjour: BonjourBrowser

    // MARK: - Configuration

    private let sharedKey: SymmetricKey
    private var deviceId: String?

    // MARK: - Internals

    private var seq: UInt64 = 0
    private var lastReceivedSeq: UInt64 = 0
    private var eventContinuation: AsyncStream<RemoteEvent>.Continuation
    private var relayListenTask: Task<Void, Never>?
    private var lanListenTask: Task<Void, Never>?
    private var bonjourObservationTask: Task<Void, Never>?
    private var relayStateTask: Task<Void, Never>?
    private var lanStateTask: Task<Void, Never>?
    private var pathMonitor: NWPathMonitor?
    private var currentLANHost: DiscoveredHost?
    private var disconnectGraceTask: Task<Void, Never>?
    private static let disconnectGracePeriod: Duration = .seconds(4)

    // MARK: - Init (Relay + LAN)

    init(relayURL: URL, apiKey: String, channelId: String, sharedKey: SymmetricKey) {
        self.relay = RelayClient(relayURL: relayURL, apiKey: apiKey, channelId: channelId)
        self.lan = LANClient()
        self.bonjour = BonjourBrowser()
        self.sharedKey = sharedKey

        var continuation: AsyncStream<RemoteEvent>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.eventContinuation = continuation
    }

    // MARK: - Init (LAN-only)

    /// Create a transport for direct LAN connections only (no relay).
    init(sharedKey: SymmetricKey, deviceId: String) {
        self.relay = nil
        self.lan = LANClient()
        self.bonjour = BonjourBrowser()
        self.sharedKey = sharedKey
        self.deviceId = deviceId

        var continuation: AsyncStream<RemoteEvent>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.eventContinuation = continuation
    }

    deinit {
        eventContinuation.finish()
        relayListenTask?.cancel()
        lanListenTask?.cancel()
        bonjourObservationTask?.cancel()
        relayStateTask?.cancel()
        lanStateTask?.cancel()
        pathMonitor?.cancel()
        disconnectGraceTask?.cancel()
    }

    // MARK: - Public API

    /// Start all transports: relay connection, Bonjour discovery, and network monitoring.
    func start() async {
        bonjour.startBrowsing()
        startBonjourObservation()

        if let relay {
            print("[CODA] TM.start: calling relay.connect()")
            await relay.connect()
            print("[CODA] TM.start: relay.connect() returned, isConnected=\(relay.isConnected)")
            startRelayListener()
            startRelayStateObservation()
        }
        startLANStateObservation()
        print("[CODA] TM.start: starting network monitor, relay.isConnected=\(relay?.isConnected ?? false)")
        startNetworkMonitor()
    }

    /// Connect to a LAN host with challenge-response auth handshake.
    /// Returns `true` if auth succeeded, `false` if rejected.
    func startLANWithAuth(host: String, port: UInt16) async -> Bool {
        await lan.connect(host: host, port: port)

        guard lan.isConnected else { return false }

        let success = await performLANAuth()
        if success {
            // Record as current LAN host so Bonjour observation doesn't re-discover and clobber us.
            currentLANHost = DiscoveredHost(
                id: "lan-direct:\(host):\(port)",
                kind: .codaDirect,
                name: host,
                host: host,
                port: port
            )
            // Reset dedup for fresh connection
            lastReceivedSeq = 0
            seq = 0
            startLANListener()
            startLANStateObservation()
            startNetworkMonitor()
            bonjour.startBrowsing()
            startBonjourObservation()
            setState(.lanPreferred)
        } else {
            lan.disconnect()
        }
        return success
    }

    /// Disconnect all transports and stop discovery.
    func stop() {
        relayListenTask?.cancel()
        relayListenTask = nil
        lanListenTask?.cancel()
        lanListenTask = nil
        bonjourObservationTask?.cancel()
        bonjourObservationTask = nil
        relayStateTask?.cancel()
        relayStateTask = nil
        lanStateTask?.cancel()
        lanStateTask = nil
        pathMonitor?.cancel()
        pathMonitor = nil
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil

        relay?.disconnect()
        lan.disconnect()
        bonjour.stopBrowsing()
        currentLANHost = nil
        setState(.disconnected)
    }

    /// Send a command to the CODA desktop via the preferred transport.
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
    /// Waits for AuthChallenge from CODA, proves we hold the shared secret,
    /// and waits for AuthResult.
    private func performLANAuth() async -> Bool {
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

    // MARK: - State machine

    private func setState(_ newState: TransportState) {
        guard state != newState else { return }
        print("[CODA] TransportManager: \(state) -> \(newState)")
        state = newState
    }

    private func updateState() {
        let lanUp = lan.isConnected
        let relayUp = relay?.isConnected ?? false
        let previousState = state

        switch (lanUp, relayUp) {
        case (true, _):
            cancelDisconnectGracePeriod()
            setState(.lanPreferred)
        case (false, true):
            cancelDisconnectGracePeriod()
            setState(.relayOnly)
        case (false, false):
            setState(.disconnected)
            // Only start the grace period on the transition into disconnected,
            // not on repeated polls that find us already disconnected.
            if previousState != .disconnected {
                startDisconnectGracePeriod()
            }
        }
    }

    /// Start a grace period before emitting `peerDisconnected`. If either
    /// transport recovers within the window, the event is suppressed.
    private func startDisconnectGracePeriod() {
        guard disconnectGraceTask == nil else { return }
        eventContinuation.yield(.transportReconnecting)
        disconnectGraceTask = Task { [weak self] in
            try? await Task.sleep(for: Self.disconnectGracePeriod)
            guard !Task.isCancelled, let self else { return }
            // Re-check: if still disconnected after the grace period, emit peerDisconnected.
            let lanUp = self.lan.isConnected
            let relayUp = self.relay?.isConnected ?? false
            if !lanUp && !relayUp {
                self.eventContinuation.yield(.peerDisconnected)
            }
            self.disconnectGraceTask = nil
        }
    }

    private func cancelDisconnectGracePeriod() {
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
    }

    // MARK: - Relay listener

    private func startRelayListener() {
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

    private func startRelayStateObservation() {
        guard let relay else { return }
        relayStateTask?.cancel()
        relayStateTask = Task { [weak self] in
            var wasConnected = false
            while !Task.isCancelled {
                guard let self else { break }
                let connected = relay.isConnected
                if connected != wasConnected {
                    wasConnected = connected
                    self.updateState()
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    // MARK: - LAN listener

    private func startLANListener() {
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

    private func startLANStateObservation() {
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

    // MARK: - Bonjour observation

    private func startBonjourObservation() {
        bonjourObservationTask?.cancel()
        bonjourObservationTask = Task { [weak self] in
            var lastKnownCount = 0
            /// Tracks whether we've already restarted the browser after a
            /// disconnect. Reset once we reconnect so future disconnects also
            /// trigger a restart.
            var didRestartBrowser = false
            while !Task.isCancelled {
                guard let self else { break }

                let hosts = self.bonjour.discoveredHosts
                let countChanged = hosts.count != lastKnownCount
                if countChanged {
                    lastKnownCount = hosts.count
                }

                // Detect LAN socket disconnect even if Bonjour hasn't noticed yet.
                if self.currentLANHost != nil, !self.lan.isConnected {
                    self.currentLANHost = nil
                    self.lanListenTask?.cancel()
                    self.lanListenTask = nil
                    self.updateState()
                }

                let needsConnect = self.currentLANHost == nil && !self.lan.isConnected

                // When disconnected with no hosts visible, restart the Bonjour
                // browser once to force NWBrowser to re-discover services.
                // NWBrowser can miss re-advertisements of a service with the
                // same name after the old one disappears.
                if needsConnect, hosts.first(where: { $0.kind == .codaDirect }) == nil, !didRestartBrowser {
                    didRestartBrowser = true
                    lastKnownCount = 0
                    self.bonjour.startBrowsing()
                }

                if countChanged || needsConnect {
                    if let host = hosts.first(where: { $0.kind == .codaDirect }),
                       !self.lan.isConnected {
                        self.currentLANHost = host
                        let authed = await self.startLANWithAuth(host: host.host, port: host.port)
                        if authed {
                            didRestartBrowser = false
                        } else {
                            self.currentLANHost = nil
                        }
                    } else if hosts.isEmpty, self.currentLANHost != nil {
                        // LAN host disappeared.
                        self.currentLANHost = nil
                        self.lan.disconnect()
                        self.lanListenTask?.cancel()
                        self.lanListenTask = nil
                        self.updateState()
                    }
                }

                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    // MARK: - Network monitor

    private func startNetworkMonitor() {
        pathMonitor?.cancel()

        let monitor = NWPathMonitor()
        self.pathMonitor = monitor

        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }

            if path.status == .satisfied {
                // Network restored. Reconnect relay if needed.
                if let relay, !relay.isConnected {
                    print("[CODA] networkMonitor: path satisfied, relay NOT connected -- reconnecting")
                    Task { @MainActor in
                        await relay.connect()
                    }
                } else {
                    print("[CODA] networkMonitor: path satisfied, relay already connected=\(self.relay?.isConnected ?? false)")
                }
                // Restart Bonjour to re-discover LAN hosts.
                self.bonjour.startBrowsing()
            } else {
                // Network lost.
                self.updateState()
            }
        }

        monitor.start(queue: .main)
    }

    // MARK: - Wire message handling

    private func buildWireMessage(payload: Data) throws -> WireMessage {
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

    private func handleIncomingData(_ data: Data, isRelay: Bool) {
        guard let wire = try? JSONDecoder().decode(WireMessage.self, from: data) else {
            return
        }

        // Check for relay control frames BEFORE dedup/encryption.
        // These are plaintext messages from the relay server itself.
        if let payloadStr = wire.payload,
           let json = try? JSONSerialization.jsonObject(with: Data(payloadStr.utf8)) as? [String: Any],
           let type = json["type"] as? String, type.hasPrefix("relay:") {
            if type == "relay:peer-disconnected" {
                startDisconnectGracePeriod()
            }
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
            return
        }

        guard let payloadData = try? E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: sharedKey) else {
            return
        }

        // Check for heartbeat: track but don't surface to the app
        if let json = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
           let type = json["type"] as? String, type == "heartbeat" {
            return
        }

        guard let event = try? JSONDecoder().decode(RemoteEvent.self, from: payloadData) else {
            return
        }

        eventContinuation.yield(event)
    }
}

// MARK: - WireMessage

/// Wire envelope for messages between CODA and the iOS app.
/// Matches the `WireMessage` type in `src/main/remote/protocol.ts`.
struct WireMessage: Codable {
    let seq: UInt64
    /// Unix ms timestamp.
    let ts: Double?
    /// JSON-encoded payload (nil when encrypted).
    let payload: String?
    /// Base64-encoded nonce (present when encrypted).
    let nonce: String?
    /// Base64-encoded ciphertext (present when encrypted, replaces payload).
    let ciphertext: String?
    /// Identifies the sending device.
    let deviceId: String?

    init(seq: UInt64, ts: Double?, payload: String?, nonce: String? = nil, ciphertext: String? = nil, deviceId: String? = nil) {
        self.seq = seq
        self.ts = ts
        self.payload = payload
        self.nonce = nonce
        self.ciphertext = ciphertext
        self.deviceId = deviceId
    }
}

// MARK: - Auth Handshake Types

struct AuthChallenge: Codable {
    let type: String  // "auth_challenge"
    let nonce: String // base64-encoded 32 random bytes
}

struct AuthResponse: Codable {
    let type: String    // "auth_response"
    let deviceId: String
    let proof: String   // HMAC-SHA256(nonce, sharedSecret), base64
}

struct AuthResult: Codable {
    let type: String    // "auth_result"
    let success: Bool
    let reason: String?
}

// MARK: - Errors

enum TransportError: Error, LocalizedError {
    case noTransportAvailable
    case encodingFailed(Error)

    var errorDescription: String? {
        switch self {
        case .noTransportAvailable:
            return "No transport available (relay and LAN both disconnected)"
        case .encodingFailed(let error):
            return "Failed to encode message: \(error.localizedDescription)"
        }
    }
}
