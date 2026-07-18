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
    /// The outbound-seq epoch of the last frame we processed. When an inbound
    /// frame carries a DIFFERENT epoch, the desktop's seq space restarted (a
    /// desktop process restart or stop()+recreate), so `lastReceivedSeq` and the
    /// pending-resend set are stale and must be reset before the seq comparison —
    /// otherwise the fresh seq=1 stream is deduped as "already seen" and the phone
    /// blackholes every post-restart frame (the retransmit buffer is also empty
    /// post-restart, so a resend request can't heal it). Nil until the first
    /// epoch-bearing frame; a desktop predating the field leaves this nil and the
    /// reset never triggers (legacy behavior preserved).
    var lastReceivedEpoch: Double?
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

    /// Escalating backoff for consecutive failed LAN auto-reconnect attempts.
    /// The Bonjour observation loop consults `nextLANAttemptAllowedAt` before
    /// each connect attempt; on a transient failure `applyLANAuthOutcome`
    /// records the failure and pushes the next-allowed time out (1s → 2s →
    /// 5s → 10s → 30s cap); a successful auth resets the ladder. See
    /// TransportManager+BonjourReconnect.swift.
    var lanReconnectBackoff = LANReconnectBackoff()
    /// Earliest wall-clock time the auto-reconnect loop may attempt the next
    /// LAN connect. `.distantPast` = no backoff window open.
    var nextLANAttemptAllowedAt: Date = .distantPast
    /// Latched when the desktop definitively rejected this device identity
    /// (auth_result success=false or application close 4000–4999, e.g. 4003
    /// "unknown device"). While set, the auto-reconnect loop makes no further
    /// LAN connect attempts on this transport — the pairing is dead and only
    /// a re-pair (which builds a fresh TransportManager) can revive it. Set
    /// by `applyLANAuthOutcome`, which also yields `.lanAuthRejected` so the
    /// ViewModel routes the user to the pairing screen.
    var lanAuthRejectedDefinitively = false

    /// Watchdog that monitors LAN heartbeat liveness. The desktop sends a
    /// heartbeat every `HEARTBEAT_INTERVAL_MS` (15s). If two intervals (30s)
    /// pass with no heartbeat while LAN is the active transport, the socket is
    /// silently dead (TCP can wedge without a FIN); the watchdog forces a
    /// reconnect+sync via `peerDisconnected` so the ViewModel re-establishes.
    var lanHeartbeatWatchdogTask: Task<Void, Never>?
    /// Wall-clock time of the most recent heartbeat received over the LAN
    /// transport specifically (relay-delivered heartbeats do not update this —
    /// they prove the relay works, not the LAN socket). Baselined to now when
    /// the watchdog arms; each LAN heartbeat effectively resets the timer.
    var lastHeartbeatAt: Date = .distantPast

    /// Wall-clock time the most recent `.snapshot` event was decoded from the
    /// wire. The retryable sync handshake (TransportManager+Sync.swift) polls
    /// this to know the desktop answered; `.distantPast` until the first one.
    var lastSnapshotReceivedAt: Date = .distantPast

    /// Strict-FIFO queue serializing outbound seq allocation + socket write so
    /// wire order always equals seq order. See TransportManager+Send.swift.
    let outboundQueue = SerialAsyncQueue()

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
            DiagnosticLog.log("start: connecting relay", tag: "transport")
            await relay.connect()
            DiagnosticLog.log("start: relay connect returned", tag: "transport", fields: [
                "connected": String(relay.isConnected)
            ])
            startRelayListener()
            startRelayStateObservation()
        }
        startLANStateObservation()
        DiagnosticLog.log("start: starting network monitor", tag: "transport", fields: [
            "relay_connected": String(relay?.isConnected ?? false)
        ])
        startNetworkMonitor()
    }

    /// Connect to a LAN host with challenge-response auth handshake.
    ///
    /// Returns a classified `LANAuthOutcome` so callers can distinguish a
    /// definitive identity rejection (explicit `auth_result success=false`,
    /// or an application close code 4000–4999 such as 4003 "unknown device")
    /// from a transient failure with no verdict (socket error, auth-cooldown
    /// close 1008, timeout, stream ended silently). Only `.rejected` may be
    /// surfaced as an auth failure; `.transient` is a normal connection
    /// failure and must go through the reconnect machinery.
    func startLANWithAuth(host: String, port: UInt16) async -> LANAuthOutcome {
        DiagnosticLog.log("lan auth start", tag: "transport.auth", fields: [
            "host": host,
            "port": String(port),
            "device_id": deviceId.map { String($0.prefix(8)) } ?? "nil"
        ])
        await lan.connect(host: host, port: port)

        let streamOutcome = await performLANAuth()
        // The auth stream alone can't see WHY a socket died; fold in the
        // close code captured by LANClient.handleDisconnect (4000–4999 →
        // definitive rejection even without an auth_result frame).
        let outcome = LANAuthOutcome.resolve(
            streamOutcome: streamOutcome,
            closeCode: lan.lastCloseCode
        )
        DiagnosticLog.log("lan auth result", tag: "transport.auth", fields: [
            "outcome": String(describing: outcome),
            "close_code": lan.lastCloseCode.map(String.init) ?? "none",
            "host": host,
            "port": String(port)
        ])
        if outcome == .success {
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
        return outcome
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
        DiagnosticLog.log("transport state changed", tag: "transport", fields: [
            "old": state.rawValue,
            "new": newState.rawValue
        ])
        state = newState
        // Arm the LAN heartbeat watchdog the moment LAN becomes the active
        // transport — not just on the first LAN heartbeat. A LAN socket that
        // dies before ever delivering a heartbeat would otherwise never arm
        // the watchdog and never be detected. Disarm when LAN stops being the
        // active transport so the watchdog only ever polices a live LAN claim.
        if newState == .lanPreferred {
            startLANHeartbeatWatchdog()
        } else {
            stopLANHeartbeatWatchdog()
        }
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

    // The LAN heartbeat watchdog (startLANHeartbeatWatchdog,
    // stopLANHeartbeatWatchdog, handleLANWatchdogFire) lives in
    // TransportManager+Watchdog.swift — this file is allowlisted
    // "don't extend; extract". See CLAUDE.md → file-architecture rules.

    // The Bonjour observation loop (startBonjourObservation, matchingLANHost)
    // and the LAN auto-reconnect policy (applyLANAuthOutcome,
    // shouldAttemptLANConnect) live in TransportManager+BonjourReconnect.swift
    // — this file is allowlisted "don't extend; extract". See CLAUDE.md →
    // file-architecture rules.

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
    /// Outbound-seq epoch (generation id). Changes when the desktop's outbound
    /// seq space resets to 1 — a desktop process restart (new RemoteTransport) or
    /// an in-process stop()+recreate. iOS resets its receive dedup high-water on
    /// an epoch change so a fresh seq=1 stream is not deduped as stale. Optional:
    /// a desktop predating the field omits it, and iOS treats absent as unchanged.
    let epoch: Double?
    /// JSON-encoded payload (nil when encrypted).
    let payload: String?
    /// Base64-encoded nonce (present when encrypted).
    let nonce: String?
    /// Base64-encoded ciphertext (present when encrypted, replaces payload).
    let ciphertext: String?
    /// Identifies the sending device.
    let deviceId: String?

    init(seq: UInt64, ts: Double?, payload: String?, nonce: String? = nil, ciphertext: String? = nil, deviceId: String? = nil, epoch: Double? = nil) {
        self.seq = seq
        self.ts = ts
        self.epoch = epoch
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
