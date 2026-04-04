import Foundation
import Observation

// MARK: - LANClient

/// WebSocket client for direct LAN connection to a CODA desktop instance.
///
/// Connects to `ws://{host}:{port}` on the local network. No authentication
/// header is needed; the LAN connection is trusted after pairing, and E2E
/// encryption provides message-level auth.
@Observable
final class LANClient {

    // MARK: - Public state

    private(set) var isConnected = false

    // MARK: - Internals

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var intentionallyClosed = false

    /// Continuation for the current connection's message stream.
    /// Replaced on each `connect()` so old iterators terminate cleanly.
    private var messageContinuation: AsyncStream<Data>.Continuation?
    /// Message stream for the current connection. Recreated on each
    /// `connect()` call so stale `for await` loops from a previous
    /// connection end immediately.
    private(set) var messages: AsyncStream<Data>

    // MARK: - Init

    init() {
        // Placeholder stream -- replaced on first connect().
        var continuation: AsyncStream<Data>.Continuation!
        self.messages = AsyncStream { continuation = $0 }
        self.messageContinuation = continuation
    }

    deinit {
        messageContinuation?.finish()
        intentionallyClosed = true
        task?.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - Public API

    /// Connect to a CODA instance at the given host and port.
    func connect(host: String, port: UInt16) async {
        intentionallyClosed = false

        // Finish old stream so any `for await` on the previous connection ends.
        messageContinuation?.finish()

        task?.cancel(with: .goingAway, reason: nil)
        task = nil

        // Create a fresh stream for this connection.
        var continuation: AsyncStream<Data>.Continuation!
        self.messages = AsyncStream { continuation = $0 }
        self.messageContinuation = continuation

        guard let url = URL(string: "ws://\(host):\(port)") else { return }

        let urlSession = URLSession(configuration: .default)
        self.session = urlSession
        let wsTask = urlSession.webSocketTask(with: url)
        self.task = wsTask

        wsTask.resume()
        isConnected = true
        receiveLoop(wsTask)
    }

    func disconnect() {
        intentionallyClosed = true
        messageContinuation?.finish()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        isConnected = false
    }

    func send(data: Data) async throws {
        guard let task, task.state == .running else {
            throw LANClientError.notConnected
        }
        try await task.send(.data(data))
    }

    // MARK: - Receive loop

    private func receiveLoop(_ wsTask: URLSessionWebSocketTask) {
        wsTask.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .success(let message):
                switch message {
                case .data(let data):
                    self.messageContinuation?.yield(data)
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        self.messageContinuation?.yield(data)
                    }
                @unknown default:
                    break
                }
                self.receiveLoop(wsTask)

            case .failure:
                self.handleDisconnect()
            }
        }
    }

    private func handleDisconnect() {
        isConnected = false
        task = nil
        // Finish the stream so any `for await` (auth, listener) exits.
        messageContinuation?.finish()
        // LAN client does not auto-reconnect. TransportManager handles
        // reconnection by monitoring Bonjour discovery state.
    }
}

// MARK: - Errors

enum LANClientError: Error, LocalizedError {
    case notConnected

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "LAN client is not connected"
        }
    }
}
