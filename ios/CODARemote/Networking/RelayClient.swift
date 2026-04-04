import Foundation
import Observation

// MARK: - RelayClient

/// WebSocket client for connecting to the CODA relay server.
///
/// Connects to `wss://relay/v1/channel/{channelId}?role=mobile`
/// with bearer token auth. Reconnects automatically with exponential backoff.
@Observable
final class RelayClient {

    // MARK: - Public state

    private(set) var isConnected = false

    // MARK: - Configuration

    private let relayURL: URL
    private let apiKey: String
    private let channelId: String

    // MARK: - Internals

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var intentionallyClosed = false
    private var pingTimer: Timer?

    private let messageContinuation: AsyncStream<Data>.Continuation
    let messages: AsyncStream<Data>

    private static let backoffBase: TimeInterval = 1.0
    private static let backoffMax: TimeInterval = 30.0
    private static let jitterMax: TimeInterval = 1.0
    private static let pingInterval: TimeInterval = 30.0

    // MARK: - Init

    init(relayURL: URL, apiKey: String, channelId: String) {
        self.relayURL = relayURL
        self.apiKey = apiKey
        self.channelId = channelId

        var continuation: AsyncStream<Data>.Continuation!
        self.messages = AsyncStream { continuation = $0 }
        self.messageContinuation = continuation
    }

    deinit {
        messageContinuation.finish()
        intentionallyClosed = true
        reconnectWork?.cancel()
        pingTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
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
        stopPing()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        isConnected = false
    }

    func send(data: Data) async throws {
        guard let task, task.state == .running else {
            throw RelayClientError.notConnected
        }
        try await task.send(.data(data))
    }

    // MARK: - Connection

    private func doConnect() async {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil

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

        guard let url = components.url else {
            print("[CODA] RelayClient: failed to build URL from components")
            scheduleReconnect()
            return
        }

        print("[CODA] RelayClient: connecting to \(url)")

        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        let urlSession = URLSession(configuration: .default)
        self.session = urlSession
        let wsTask = urlSession.webSocketTask(with: request)
        self.task = wsTask

        wsTask.resume()

        // The first successful receive confirms the connection is open.
        reconnectAttempt = 0
        isConnected = true
        startPing()
        receiveLoop(wsTask)
    }

    private func receiveLoop(_ wsTask: URLSessionWebSocketTask) {
        wsTask.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .success(let message):
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
                print("[CODA] RelayClient: receive failed: \(error)")
                self.handleDisconnect()
            }
        }
    }

    private func handleDisconnect() {
        isConnected = false
        stopPing()
        task = nil

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

        print("[CODA] RelayClient: scheduleReconnect in \(Int(delay))ms (attempt \(reconnectAttempt + 1))")
        reconnectAttempt += 1

        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.intentionallyClosed else { return }
            print("[CODA] RelayClient: reconnect timer fired")
            Task { @MainActor in
                await self.doConnect()
            }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: - Ping/Pong keepalive

    private func startPing() {
        stopPing()
        pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingInterval, repeats: true) { [weak self] _ in
            self?.task?.sendPing { error in
                if error != nil {
                    self?.handleDisconnect()
                }
            }
        }
    }

    private func stopPing() {
        pingTimer?.invalidate()
        pingTimer = nil
    }
}

// MARK: - Errors

enum RelayClientError: Error, LocalizedError {
    case notConnected

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Relay client is not connected"
        }
    }
}
