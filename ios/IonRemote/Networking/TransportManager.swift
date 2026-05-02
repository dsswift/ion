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
/// - **LAN-only**: no relay, direct connection to an Ion instance with auth
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

    let sharedKey: SymmetricKey
    var deviceId: String?

    // MARK: - Internals

    /// Set by `stop()` to prevent a deferred `start()` Task from
    /// resurrecting a transport that was already torn down.
    private(set) var isStopped = false
    var seq: UInt64 = 0
    var lastReceivedSeq: UInt64 = 0
    let eventContinuation: AsyncStream<RemoteEvent>.Continuation
    var relayListenTask: Task<Void, Never>?
    var lanListenTask: Task<Void, Never>?
    var bonjourObservationTask: Task<Void, Never>?
    var relayStateTask: Task<Void, Never>?
    var lanStateTask: Task<Void, Never>?
    var pathMonitor: NWPathMonitor?
    var currentLANHost: DiscoveredHost?
    var disconnectGraceTask: Task<Void, Never>?
    static let disconnectGracePeriod: Duration = .seconds(4)

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
        guard !isStopped else { return }

        bonjour.startBrowsing()
        startBonjourObservation()

        if let relay {
            print("[Ion] TM.start: calling relay.connect()")
            await relay.connect()
            print("[Ion] TM.start: relay.connect() returned, isConnected=\(relay.isConnected)")
            startRelayListener()
            startRelayStateObservation()
        }
        startLANStateObservation()
        print("[Ion] TM.start: starting network monitor, relay.isConnected=\(relay?.isConnected ?? false)")
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
                kind: .ionDirect,
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
        isStopped = true

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

    // MARK: - State machine

    func setState(_ newState: TransportState) {
        guard state != newState else { return }
        print("[Ion] TransportManager: \(state) -> \(newState)")
        state = newState
    }

    func updateState() {
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
    ///
    /// - Parameter force: When `true` (relay told us the peer disconnected),
    ///   emit `peerDisconnected` after the grace period even if the relay
    ///   WebSocket itself is still connected. The relay transport being up
    ///   doesn't mean the peer is reachable.
    func startDisconnectGracePeriod(force: Bool = false) {
        guard disconnectGraceTask == nil else { return }
        eventContinuation.yield(.transportReconnecting)
        disconnectGraceTask = Task { [weak self] in
            try? await Task.sleep(for: Self.disconnectGracePeriod)
            guard !Task.isCancelled, let self else { return }
            if force {
                // The relay explicitly told us the peer is gone.
                // Unless this task was cancelled (by peer-reconnected), emit.
                self.eventContinuation.yield(.peerDisconnected)
            } else {
                // Transport-level disconnect: re-check connectivity.
                let lanUp = self.lan.isConnected
                let relayUp = self.relay?.isConnected ?? false
                if !lanUp && !relayUp {
                    self.eventContinuation.yield(.peerDisconnected)
                }
            }
            self.disconnectGraceTask = nil
        }
    }

    func cancelDisconnectGracePeriod() {
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
    }

    // MARK: - Bonjour observation

    func startBonjourObservation() {
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
                if needsConnect, hosts.first(where: { $0.kind == .ionDirect }) == nil, !didRestartBrowser {
                    didRestartBrowser = true
                    lastKnownCount = 0
                    self.bonjour.startBrowsing()
                }

                if countChanged || needsConnect {
                    if let host = hosts.first(where: { $0.kind == .ionDirect }),
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

    func startNetworkMonitor() {
        pathMonitor?.cancel()

        let monitor = NWPathMonitor()
        self.pathMonitor = monitor

        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, !self.isStopped else { return }

            if path.status == .satisfied {
                // Network restored. Reconnect relay if needed.
                if let relay, !relay.isConnected, !relay.isConnecting {
                    print("[Ion] networkMonitor: path satisfied, relay NOT connected -- reconnecting")
                    Task { @MainActor in
                        await relay.connect()
                    }
                } else {
                    print("[Ion] networkMonitor: path satisfied, relay connected=\(self.relay?.isConnected ?? false) connecting=\(self.relay?.isConnecting ?? false)")
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
}

// MARK: - WireMessage

/// Wire envelope for messages between Ion and the iOS app.
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
