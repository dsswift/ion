import Foundation
import Observation

// MARK: - RelayClient

/// WebSocket client for connecting to the Ion relay server.
///
/// Connects to `wss://relay/v1/channel/{channelId}?role=mobile`
/// with bearer token auth. Reconnects automatically with exponential backoff.
@Observable
final class RelayClient {

    // MARK: - Public state

    private(set) var isConnected = false
    /// True while a connection attempt is in progress (between `connect()`
    /// and the first successful receive or a failure). Prevents callers
    /// like `NWPathMonitor` from triggering duplicate connection attempts.
    private(set) var isConnecting = false

    // MARK: - Configuration

    private let relayURL: URL
    private let apiKey: String
    private let channelId: String
    private let apnsToken: String?
    private let getCredential: (() async throws -> String)?
    private let onTokenRejected: (() -> Void)?
    private let onIdentityMismatch: (() -> Void)?

    // MARK: - Internals

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var intentionallyClosed = false
    /// Keepalive ping loop. A `Task.sleep` loop, NOT a `Timer`: `startPing()`
    /// is called from `receiveLoop`'s URLSession completion handler, which
    /// runs on a URLSession delegate thread with no running RunLoop —
    /// `Timer.scheduledTimer` there registers on a RunLoop that never spins,
    /// so the timer never fires, no pings go out, NAT idles the socket, and
    /// death is detected only on a later receive failure. The task-based loop
    /// is scheduler-driven and fires regardless of the calling thread.
    /// Cancelled by `stopPing()` (disconnect/handleDisconnect/deinit) and
    /// self-terminates if a newer WebSocket task supersedes the one it was
    /// started for.
    private var pingTask: Task<Void, Never>?

    private let messageContinuation: AsyncStream<Data>.Continuation
    let messages: AsyncStream<Data>

    private static let backoffBase: TimeInterval = 1.0
    private static let backoffMax: TimeInterval = 30.0
    private static let jitterMax: TimeInterval = 1.0
    private static let pingInterval: TimeInterval = 30.0

    // MARK: - Init

    init(relayURL: URL, apiKey: String, channelId: String, apnsToken: String? = nil,
         getCredential: (() async throws -> String)? = nil,
         onTokenRejected: (() -> Void)? = nil,
         onIdentityMismatch: (() -> Void)? = nil) {
        self.relayURL = relayURL
        self.apiKey = apiKey
        self.channelId = channelId
        self.apnsToken = apnsToken
        self.getCredential = getCredential
        self.onTokenRejected = onTokenRejected
        self.onIdentityMismatch = onIdentityMismatch

        var continuation: AsyncStream<Data>.Continuation!
        self.messages = AsyncStream { continuation = $0 }
        self.messageContinuation = continuation
    }

    deinit {
        messageContinuation.finish()
        intentionallyClosed = true
        reconnectWork?.cancel()
        pingTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }

    // MARK: - Public API

    func connect() async {
        intentionallyClosed = false
        await doConnect()
    }

    func disconnect() {
        intentionallyClosed = true
        reconnectWork?.cancel()
        reconnectWork = nil
        reconnectAttempt = 0
        isConnecting = false
        stopPing()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
    }

    func send(data: Data) async throws {
        guard let task, task.state == .running else {
            throw RelayClientError.notConnected
        }
        // A wedged TCP connection can keep `task.state == .running` while
        // `send` never completes — commands then await indefinitely, pile up,
        // and later fail en masse with "Operation canceled". Bound every send
        // with a deadline; on timeout treat the transport as failed and tear
        // it down so the reconnect/backoff path takes over.
        do {
            try await withSendDeadline(seconds: transportSendDeadlineSeconds) {
                try await task.send(.data(data))
            }
        } catch is SendDeadlineError {
            DiagnosticLog.log("relay send timed out, tearing down", tag: "relay.client", level: .error, fields: [
                "timeout_s": String(transportSendDeadlineSeconds),
                "bytes": String(data.count)
            ])
            handleDisconnect()
            throw RelayClientError.sendTimeout
        }
    }

    // MARK: - Connection

    private func doConnect() async {
        guard !intentionallyClosed else { return }

        isConnecting = true

        // Cancel any pending reconnect timer so we don't get a stale
        // doConnect() call racing with this one.
        reconnectWork?.cancel()
        reconnectWork = nil

        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil

        // Build the WebSocket URL: {relayURL}/v1/channel/{channelId}?role=mobile
        var components = URLComponents()
        // Map http(s) to ws(s) if needed; pass ws(s) through as-is.
        switch relayURL.scheme {
        case "https", "wss": components.scheme = "wss"
        default:             components.scheme = "ws"
        }
        components.host = relayURL.host(percentEncoded: false)
        components.port = relayURL.port
        let basePath = relayURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let fullPath = basePath.isEmpty
            ? "/v1/channel/\(channelId)"
            : "/\(basePath)/v1/channel/\(channelId)"
        components.path = fullPath
        components.queryItems = [
            URLQueryItem(name: "role", value: "mobile"),
        ]
        if let token = apnsToken, !token.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "apns_token", value: token))
        }

        guard let url = components.url else {
            DiagnosticLog.log("failed to build relay URL from components", tag: "relay.client", level: .error, fields: [
                "scheme": components.scheme ?? "nil",
                "host": components.host ?? "nil"
            ])
            scheduleReconnect()
            return
        }

        DiagnosticLog.log("relay websocket connecting", tag: "relay.client", fields: [
            "url": url.absoluteString
        ])

        var request = URLRequest(url: url)
        let bearer: String
        if let getCredential {
            do {
                bearer = try await getCredential()
            } catch {
                DiagnosticLog.log("relay credential fetch failed, scheduling reconnect", tag: "relay.client", level: .warn, fields: [
                    "error": error.localizedDescription
                ])
                scheduleReconnect()
                return
            }
        } else {
            bearer = apiKey
        }
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")

        let urlSession = URLSession(configuration: .default)
        self.session = urlSession
        let wsTask = urlSession.webSocketTask(with: request)
        // Default maximumMessageSize is 1 MiB. Encrypted snapshots can
        // exceed that, causing EMSGSIZE ("Message too long").
        wsTask.maximumMessageSize = 16 * 1024 * 1024
        self.task = wsTask

        wsTask.resume()

        // Don't set isConnected or reset backoff here — the first
        // successful receive in receiveLoop confirms the handshake.
        receiveLoop(wsTask)
    }

    private func receiveLoop(_ wsTask: URLSessionWebSocketTask) {
        wsTask.receive { [weak self] result in
            guard let self else { return }

            // Ignore callbacks from a superseded task (e.g. after doConnect
            // cancelled the old task and started a new one).
            guard wsTask === self.task else { return }

            switch result {
            case .success(let message):
                // First successful receive confirms the WebSocket is open.
                if !self.isConnected {
                    self.isConnected = true
                    self.isConnecting = false
                    self.reconnectAttempt = 0
                    DiagnosticLog.log("relay websocket connected (first receive)", tag: "relay.client")
                    // Cancel any pending reconnect timer from a previous
                    // failed attempt so it doesn't tear down this connection.
                    self.reconnectWork?.cancel()
                    self.reconnectWork = nil
                    self.startPing()
                }
                switch message {
                case .data(let data):
                    self.messageContinuation.yield(data)
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        self.messageContinuation.yield(data)
                    }
                @unknown default:
                    break
                }
                // Continue receiving.
                self.receiveLoop(wsTask)

            case .failure(let error):
                // Inspect BOTH rejection signals before clearing state — the
                // relay refuses a bad credential two different ways depending
                // on when it notices.
                //
                // Close code 4401 is the mid-connection case: the relay's
                // expiry watcher closes an open socket whose token has aged
                // out. URLSessionWebSocketTask surfaces it via
                // `closeCode.rawValue`.
                //
                // HTTP 401/403 is the connect-time case: `auth.Validate` runs
                // in the HTTP handler BEFORE the WebSocket upgrade, so a token
                // that is already bad is refused with a plain HTTP status and
                // no WebSocket is ever created. There is no close code at all
                // — only `task.response`. Reading just the close code (as this
                // did) made every stale-token connect look like a generic
                // network error, so the credential was never invalidated and
                // the backoff ladder retried the same dead token forever.
                //
                // iOS acquires tokens autonomously: onTokenRejected invalidates
                // the cached access token, and the next connect resolves a
                // fresh one through OIDCTokenManager.accessToken() — silent
                // Keychain refresh when possible, interactive PKCE when the
                // refresh token is gone. A fresh relay_config pushed by the
                // desktop is still honored, but iOS no longer depends on it to
                // recover.
                //
                // HTTP 403 is the exception and is handled separately below: it
                // means the channel is owned by a different OIDC subject, which
                // no refresh can fix.
                let rawCloseCode = wsTask.closeCode.rawValue
                let httpStatus = (wsTask.response as? HTTPURLResponse)?.statusCode
                let rejection = RelayRejection.classify(
                    closeCode: rawCloseCode > 0 ? rawCloseCode : nil,
                    httpStatus: httpStatus
                )
                switch rejection {
                case .identityMismatch:
                    // Terminal for this pairing. Reconnecting would present the
                    // same subject and be refused identically, so stop the
                    // ladder and let the user pick the right account.
                    self.intentionallyClosed = true
                    self.onIdentityMismatch?()
                    DiagnosticLog.log("relay refused credential: channel owned by another identity, not retrying", tag: "relay.client", level: .error, fields: [
                        "close_code": rawCloseCode > 0 ? String(rawCloseCode) : "none",
                        "http_status": httpStatus.map(String.init) ?? "none",
                        "error": error.localizedDescription
                    ])
                case .expiredCredential:
                    self.onTokenRejected?()
                    DiagnosticLog.log("relay rejected credential, invalidating token", tag: "relay.client", level: .warn, fields: [
                        "close_code": rawCloseCode > 0 ? String(rawCloseCode) : "none",
                        "http_status": httpStatus.map(String.init) ?? "none",
                        "error": error.localizedDescription
                    ])
                case .none:
                    DiagnosticLog.log("relay websocket receive failed", tag: "relay.client", level: .warn, fields: [
                        "error": error.localizedDescription,
                        "close_code": rawCloseCode > 0 ? String(rawCloseCode) : "none",
                        "http_status": httpStatus.map(String.init) ?? "none"
                    ])
                }
                self.handleDisconnect()
            }
        }
    }

    private func handleDisconnect() {
        isConnected = false
        isConnecting = false
        stopPing()
        task = nil
        session?.invalidateAndCancel()
        session = nil

        if !intentionallyClosed {
            scheduleReconnect()
        }
    }

    // MARK: - Reconnection

    private func scheduleReconnect() {
        let delay = min(
            Self.backoffBase * pow(2.0, Double(reconnectAttempt)),
            Self.backoffMax
        ) + Double.random(in: 0...Self.jitterMax)

        DiagnosticLog.log("relay reconnect scheduled", tag: "relay.client", fields: [
            "delay_s": String(Int(delay)),
            "attempt": String(reconnectAttempt + 1)
        ])
        reconnectAttempt += 1

        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.intentionallyClosed else { return }
            DiagnosticLog.log("relay reconnect timer fired", tag: "relay.client")
            Task { @MainActor in
                guard !self.intentionallyClosed else { return }
                await self.doConnect()
            }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: - Ping/Pong keepalive

    /// True while the keepalive ping loop is running. Test seam: pins the
    /// lifecycle (started on first receive, cancelled on stop/disconnect)
    /// without a live socket.
    var isPingKeepaliveActive: Bool {
        pingTask != nil
    }

    /// Start the keepalive ping loop for the current WebSocket task.
    /// Internal (not private) so tests can pin the lifecycle contract.
    func startPing() {
        stopPing()
        // Capture the task this loop keeps alive; if doConnect supersedes it,
        // the loop exits on its own (stopPing/startPing also runs on the new
        // connection's first receive, but this guard closes the window where
        // an orphaned loop pings a dead task).
        let owner = task
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.pingInterval))
                guard !Task.isCancelled, let self else { return }
                guard let current = self.task, current === owner else { return }
                current.sendPing { [weak self] error in
                    if error != nil {
                        DiagnosticLog.log("relay keepalive ping failed", tag: "relay.client", level: .warn, fields: [
                            "error": error.map { $0.localizedDescription } ?? "unknown"
                        ])
                        self?.handleDisconnect()
                    }
                }
            }
        }
    }

    /// Cancel the keepalive ping loop. Internal (not private) so tests can
    /// pin the lifecycle contract.
    func stopPing() {
        pingTask?.cancel()
        pingTask = nil
    }
}

// MARK: - Errors

enum RelayClientError: Error, LocalizedError {
    case notConnected
    case sendTimeout

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Relay client is not connected"
        case .sendTimeout:
            return "Relay send timed out (connection wedged); transport torn down"
        }
    }
}
