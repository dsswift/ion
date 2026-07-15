import Foundation
import CryptoKit
import Network
import Observation
import os

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
    /// Bonjour service name of the paired desktop (e.g. "MacBookPro").
    /// Used to filter Bonjour discovery to the correct host when multiple
    /// Ion instances are on the network.
    var deviceName: String?

    // MARK: - Internals

    /// Set by `stop()` to prevent a deferred `start()` Task from
    /// resurrecting a transport that was already torn down.
    private(set) var isStopped = false
    let _seqLock = OSAllocatedUnfairLock(initialState: UInt64(0))
    var lastReceivedSeq: UInt64 = 0
    /// Outstanding gap-recovery range awaiting replayed frames from the desktop.
    /// While set, an inbound frame whose seq falls in this (still-missing) set is
    /// APPLIED even though it is below `lastReceivedSeq` (the normal dedup would
    /// otherwise drop the very frames we asked the desktop to resend). Filled
    /// seqs are removed; cleared when empty or on desktop_resend_unavailable.
    /// See TransportManager+Receive.swift requestResendForGap / pendingResend.
    var pendingResendSeqs: Set<UInt64> = []
    /// Debounce: the last time a resend request was sent, so a burst of gaps
    /// coalesces into one request.
    var lastResendRequestAt: Date = .distantPast
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

    /// Watchdog that monitors LAN heartbeat liveness. The desktop sends a
    /// heartbeat every `HEARTBEAT_INTERVAL_MS` (15s). If two intervals (30s)
    /// pass with no heartbeat while LAN is the active transport, the socket is
    /// silently dead (TCP can wedge without a FIN); the watchdog forces a
    /// reconnect+sync via `peerDisconnected` so the ViewModel re-establishes.
    var lanHeartbeatWatchdogTask: Task<Void, Never>?
    /// Wall-clock time of the most recent heartbeat received over the wire.
    /// Updated by the receive path before it yields `.heartbeat`. The watchdog
    /// compares against this; each new heartbeat effectively resets the timer.
    var lastHeartbeatAt: Date = .distantPast

    /// One-way clock-skew estimate in milliseconds (positive = iOS clock is ahead
    /// of the desktop). Updated from `desktop_heartbeat` frames by comparing iOS
    /// wall-clock receive time against the desktop's `ts` field.
    /// Used by the receive-latency logger to produce a skew-corrected latency
    /// value: `adjusted_latency_ms = raw_latency_ms - clockSkewEstimate_ms`.
    /// Exponential moving average with α = 0.25.
    var clockSkewEstimateMs: Double = 0.0

    // MARK: - Init (Relay + LAN)

    init(relayURL: URL, apiKey: String, channelId: String, sharedKey: SymmetricKey, apnsToken: String? = nil) {
        self.relay = RelayClient(relayURL: relayURL, apiKey: apiKey, channelId: channelId, apnsToken: apnsToken)
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
        lanHeartbeatWatchdogTask?.cancel()
    }

    // MARK: - Public API

    /// Start all transports: relay connection, Bonjour discovery, and network monitoring.
    func start() async {
        guard !isStopped else { return }

        await MainActor.run { self.bonjour.startBrowsing() }
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
        DiagnosticLog.log("lan auth start", tag: "transport.auth", fields: [
            "host": host,
            "port": String(port),
            "device_id": deviceId.map { String($0.prefix(8)) } ?? "nil"
        ])
        await lan.connect(host: host, port: port)

        let success = await performLANAuth()
        DiagnosticLog.log("lan auth result", tag: "transport.auth", fields: [
            "success": String(success),
            "host": host,
            "port": String(port)
        ])
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
            _seqLock.withLock { state in state = 0 }
            startLANListener()
            startLANStateObservation()
            startNetworkMonitor()
            // Start Bonjour browsing so the observation loop can auto-reconnect
            // if this connection drops. In LAN-only mode (no relay), the browser
            // wouldn't be started otherwise since start() is never called.
            await MainActor.run { self.bonjour.startBrowsing() }
            startBonjourObservation()
            setState(.lanPreferred)
        } else {
            lan.disconnect()
        }
        return success
    }

    /// Disconnect all transports and stop discovery.
    func stop() {
        DiagnosticLog.log("TM: stop() called")
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
        stopLANHeartbeatWatchdog()

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
        DiagnosticLog.log("transport state changed", tag: "transport", fields: [
            "old": state.rawValue,
            "new": newState.rawValue
        ])
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
        DiagnosticLog.log("disconnect grace period start", tag: "transport", fields: [
            "force": String(force)
        ])
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

    // MARK: - LAN heartbeat watchdog

    /// Start (or restart) the LAN heartbeat liveness watchdog.
    ///
    /// The desktop emits a heartbeat every `HEARTBEAT_INTERVAL_MS` (15s). A
    /// healthy LAN connection therefore refreshes `lastHeartbeatAt` at least
    /// that often. If two full intervals (`intervalSeconds`, default 30s) elapse
    /// with no heartbeat while LAN is the active transport, the socket is
    /// silently dead — TCP can wedge without delivering a FIN, so the receive
    /// loop never ends and no `peerDisconnected` is emitted. The watchdog
    /// detects that starvation and forces a reconnect+sync by yielding
    /// `.peerDisconnected`, the same signal the LAN stream-ended path uses.
    ///
    /// Idempotent: an already-running watchdog is left in place (its loop
    /// re-reads `lastHeartbeatAt`, so a fresh heartbeat effectively resets the
    /// timer without needing a restart). `intervalSeconds` is injectable so the
    /// unit test can drive the loop on a short cadence.
    func startLANHeartbeatWatchdog(intervalSeconds: Double = 30.0) {
        guard lanHeartbeatWatchdogTask == nil else { return }
        DiagnosticLog.log("lan heartbeat watchdog starting", tag: "transport", fields: [
            "interval_s": String(intervalSeconds)
        ])
        lanHeartbeatWatchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(intervalSeconds))
                guard !Task.isCancelled, let self else { return }
                let elapsed = Date().timeIntervalSince(self.lastHeartbeatAt)
                if elapsed > intervalSeconds {
                    DiagnosticLog.log("WATCHDOG: LAN heartbeat starved, triggering reconnect+sync")
                    // Force the ViewModel to reconnect (which re-syncs). Mirrors
                    // the LAN stream-ended path's recovery signal.
                    self.eventContinuation.yield(.peerDisconnected)
                    return
                }
            }
        }
    }

    /// Stop the LAN heartbeat watchdog (called on stop() and teardown).
    func stopLANHeartbeatWatchdog() {
        lanHeartbeatWatchdogTask?.cancel()
        lanHeartbeatWatchdogTask = nil
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

                let hosts = await MainActor.run { self.bonjour.discoveredHosts }
                let countChanged = hosts.count != lastKnownCount
                if countChanged {
                    lastKnownCount = hosts.count
                }

                // Detect LAN socket disconnect even if Bonjour hasn't noticed yet.
                if self.currentLANHost != nil, !self.lan.isConnected {
                    DiagnosticLog.log("BONJOUR: LAN socket lost, clearing host")
                    self.currentLANHost = nil
                    self.lanListenTask?.cancel()
                    self.lanListenTask = nil
                    self.updateState()
                }

                let needsConnect = self.currentLANHost == nil && !self.lan.isConnected
                if needsConnect { DiagnosticLog.log("BONJOUR: needsConnect=true") }

                // When disconnected with no hosts visible, restart the Bonjour
                // browser once to force NWBrowser to re-discover services.
                // NWBrowser can miss re-advertisements of a service with the
                // same name after the old one disappears.
                if needsConnect, self.matchingLANHost(hosts) == nil, !didRestartBrowser {
                    didRestartBrowser = true
                    lastKnownCount = 0
                    await MainActor.run { self.bonjour.startBrowsing() }
                }

                if countChanged || needsConnect {
                    if let host = self.matchingLANHost(hosts),
                       !self.lan.isConnected {
                        DiagnosticLog.log("bonjour connecting to host", tag: "transport.bonjour", fields: [
                            "name": host.name,
                            "host": host.host,
                            "port": String(host.port)
                        ])
                        self.currentLANHost = host
                        let authed = await self.startLANWithAuth(host: host.host, port: host.port)
                        if authed {
                            didRestartBrowser = false
                            do {
                                try await self.send(.sync)
                            } catch {
                                print("[Ion] bonjour auth ok but sync failed: \(error)")
                            }
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

    /// Find the Bonjour host that matches the active paired device.
    /// When `deviceName` is set, only the host with a matching Bonjour service
    /// name is returned. This prevents connecting to the wrong desktop when
    /// multiple Ion instances are on the network.
    private func matchingLANHost(_ hosts: [DiscoveredService]) -> DiscoveredService? {
        let ionHosts = hosts.filter { $0.kind == .ionDirect }
        if let name = deviceName {
            let match = ionHosts.first { $0.name == name }
            if match == nil && !ionHosts.isEmpty {
                DiagnosticLog.log("bonjour host filter no match", tag: "transport.bonjour", fields: [
                    "filter": name,
                    "available": String(describing: ionHosts.map(\.name))
                ])
            }
            return match
        }
        // Fallback: no name filter (single desktop / legacy).
        return ionHosts.first
    }

    // MARK: - Network monitor

    func startNetworkMonitor() {
        pathMonitor?.cancel()

        let monitor = NWPathMonitor()
        self.pathMonitor = monitor

        var isFirstUpdate = true
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, !self.isStopped else { return }
            defer { isFirstUpdate = false }

            if path.status == .satisfied {
                // Network restored. Reconnect relay if needed.
                if let relay, !relay.isConnected, !relay.isConnecting {
                    Task { @MainActor in await relay.connect() }
                }
                // Restart Bonjour only when recovering from a real outage:
                // - Skip the first callback (fires immediately on monitor.start(),
                //   resetting browsers we just started in start()).
                // - Skip when LAN is already connected (path changes as TCP
                //   establishes would clear discoveredHosts and fake a disconnect).
                if !isFirstUpdate && self.state != .lanPreferred {
                    self.bonjour.startBrowsing()
                }
            } else {
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
