import Foundation
import CryptoKit

/// A WebSocket whose every frame, both ways, is a `SealedEnvelope` under one
/// pairing's shared secret. The two paired routes are this class with a
/// different request: `StudioTCPSocket` and `StudioRelaySocket` only say where
/// to dial and whether the far end speaks relay control frames.
///
/// An inbound frame that does not open is dropped and logged, never delivered.
final class StudioSealedSocket: StudioSocket, @unchecked Sendable {

    struct Options: Sendable {
        /// Names the far end in logs (a host). Never a secret or a full URL with a token.
        var label: String
        /// A relay sends a few plaintext `relay:*` control frames to the joining side; they are not envelopes.
        var skipRelayControlFrames: Bool
    }

    let routeKind: StudioRouteKind
    let events: AsyncStream<StudioSocketEvent>

    private let continuation: AsyncStream<StudioSocketEvent>.Continuation
    private let key: SymmetricKey
    private let options: Options
    private let makeRequest: @Sendable () async throws -> URLRequest
    private let taskFactory: RelayWebSocketTaskFactory

    private let lock = NSLock()
    private var task: RelayWebSocketTasking?
    private var didOpen = false
    private var didClose = false
    private var dialTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?

    /// Idle NATs and relays drop a silent socket; a ping this often keeps it mapped.
    private static let keepaliveIntervalSeconds: Double = 30

    /// - Parameter makeRequest: builds the upgrade request at dial time, so a
    ///   bearer that must be fetched (an OIDC token) is fetched per dial.
    init(
        routeKind: StudioRouteKind,
        key: SymmetricKey,
        options: Options,
        taskFactory: RelayWebSocketTaskFactory = URLSessionRelayWebSocketTaskFactory(),
        makeRequest: @escaping @Sendable () async throws -> URLRequest
    ) {
        self.routeKind = routeKind
        self.key = key
        self.options = options
        self.taskFactory = taskFactory
        self.makeRequest = makeRequest
        var continuation: AsyncStream<StudioSocketEvent>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    // MARK: - StudioSocket

    func open() {
        let dial = Task { [weak self] in
            guard let self else { return }
            let request: URLRequest
            do {
                request = try await self.makeRequest()
            } catch {
                DiagnosticLog.log("studio socket: could not build the dial request", tag: "studio.socket", level: .warn, fields: [
                    "route": self.routeKind.rawValue, "peer": self.options.label, "error": error.localizedDescription
                ])
                self.finish(StudioSocketClosure(closeCode: nil, httpStatus: nil, reason: "dial request failed: \(error.localizedDescription)"))
                return
            }
            guard !Task.isCancelled, !self.isClosed else {
                DiagnosticLog.log("studio socket: dial abandoned, socket was closed first", tag: "studio.socket", fields: [
                    "route": self.routeKind.rawValue, "peer": self.options.label
                ])
                return
            }
            self.start(request)
        }
        lock.withLock { dialTask = dial }
    }

    func send(text: String, traceparent: String?) async throws {
        try await sendEnvelope(try SealedEnvelope.seal(text: text, key: key, traceparent: traceparent))
    }

    func send(binary: Data) async throws {
        try await sendEnvelope(try SealedEnvelope.seal(binary: binary, key: key))
    }

    func close() {
        DiagnosticLog.log("studio socket: closed by caller", tag: "studio.socket", fields: [
            "route": routeKind.rawValue, "peer": options.label
        ])
        finish(StudioSocketClosure(closeCode: nil, httpStatus: nil, reason: "closed by caller"), closeCode: .normalClosure)
    }

    // MARK: - Dial and receive

    private var isClosed: Bool { lock.withLock { didClose } }

    private func start(_ request: URLRequest) {
        let wsTask = taskFactory.makeTask(request: request)
        // The default 1 MiB cap is smaller than a sealed snapshot or transcript page.
        wsTask.maximumMessageSize = 16 * 1024 * 1024
        lock.withLock { task = wsTask }
        DiagnosticLog.log("studio socket: dialing", tag: "studio.socket", fields: [
            "route": routeKind.rawValue, "peer": options.label
        ])
        wsTask.resume()
        receive(on: wsTask)
        // URLSessionWebSocketTask reports no "did open" without a delegate. A
        // pong proves the upgrade finished; the first inbound frame proves it too.
        wsTask.sendPing { [weak self] error in
            guard let self else { return }
            if let error {
                DiagnosticLog.log("studio socket: open probe failed", tag: "studio.socket", level: .warn, fields: [
                    "route": self.routeKind.rawValue, "peer": self.options.label, "error": error.localizedDescription
                ])
                self.finish(self.closure(of: wsTask, error: error))
                return
            }
            self.markOpen(via: "pong")
        }
    }

    private func markOpen(via signal: String) {
        let first = lock.withLock { () -> Bool in
            guard !didOpen, !didClose else { return false }
            didOpen = true
            return true
        }
        guard first else { return }
        DiagnosticLog.log("studio socket: open", tag: "studio.socket", fields: [
            "route": routeKind.rawValue, "peer": options.label, "signal": signal
        ])
        continuation.yield(.opened)
        startKeepalive()
    }

    private func startKeepalive() {
        let loop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(Self.keepaliveIntervalSeconds))
                } catch {
                    // Cancellation is the normal stop path for this loop.
                    return
                }
                guard let self, let current = self.lock.withLock({ self.didClose ? nil : self.task }) else { return }
                current.sendPing { [weak self] error in
                    guard let self, let error else { return }
                    DiagnosticLog.log("studio socket: keepalive ping failed", tag: "studio.socket", level: .warn, fields: [
                        "route": self.routeKind.rawValue, "peer": self.options.label, "error": error.localizedDescription
                    ])
                    self.finish(self.closure(of: current, error: error))
                }
            }
        }
        let stale = lock.withLock { () -> Bool in
            guard !didClose else { return true }
            keepaliveTask = loop
            return false
        }
        if stale { loop.cancel() }
    }

    private func receive(on wsTask: RelayWebSocketTasking) {
        wsTask.receive { [weak self] result in
            guard let self, !self.isClosed else { return }
            switch result {
            case .success(let message):
                self.markOpen(via: "first frame")
                switch message {
                case .string(let text): self.handleRaw(text)
                case .data(let data):
                    // An envelope is always text. Raw bytes here were sealed by nobody.
                    DiagnosticLog.log("studio socket: unsealed binary frame dropped", tag: "studio.socket", level: .warn, fields: [
                        "route": self.routeKind.rawValue, "peer": self.options.label, "bytes": String(data.count)
                    ])
                @unknown default:
                    DiagnosticLog.log("studio socket: unknown websocket message kind dropped", tag: "studio.socket", level: .warn, fields: [
                        "route": self.routeKind.rawValue, "peer": self.options.label
                    ])
                }
                self.receive(on: wsTask)
            case .failure(let error):
                self.finish(self.closure(of: wsTask, error: error))
            }
        }
    }

    private func handleRaw(_ text: String) {
        if options.skipRelayControlFrames, Self.isRelayControlFrame(text) {
            DiagnosticLog.log("studio socket: relay control frame skipped", tag: "studio.socket", level: .debug, fields: [
                "peer": options.label, "head": String(text.prefix(60))
            ])
            return
        }
        guard let opened = SealedEnvelope.open(text, key: key) else {
            DiagnosticLog.log("studio socket: frame dropped, not an envelope for this pairing or failed to open", tag: "studio.socket", level: .warn, fields: [
                "route": routeKind.rawValue, "peer": options.label, "bytes": String(text.utf8.count)
            ])
            return
        }
        if opened.isBinary {
            continuation.yield(.binary(opened.bytes))
            return
        }
        guard let frameText = String(data: opened.bytes, encoding: .utf8) else {
            DiagnosticLog.log("studio socket: opened text frame is not UTF-8, dropped", tag: "studio.socket", level: .warn, fields: [
                "route": routeKind.rawValue, "peer": options.label
            ])
            return
        }
        continuation.yield(.text(frameText))
    }

    /// Whether `text` is one of the relay's own plaintext frames: a JSON object
    /// whose first member is `"type":"relay:…"`.
    static func isRelayControlFrame(_ text: String) -> Bool {
        text.range(of: #"^\s*\{\s*"type"\s*:\s*"relay:"#, options: .regularExpression) != nil
    }

    // MARK: - Send and finish

    private func sendEnvelope(_ envelope: String) async throws {
        let current = lock.withLock { didClose ? nil : task }
        guard let current, current.state == .running else { throw StudioSocketError.notOpen }
        do {
            try await withSendDeadline(seconds: transportSendDeadlineSeconds) {
                try await current.send(.string(envelope))
            }
        } catch is SendDeadlineError {
            // A wedged connection keeps `.running` while a send never completes.
            DiagnosticLog.log("studio socket: send timed out, tearing down", tag: "studio.socket", level: .error, fields: [
                "route": routeKind.rawValue, "peer": options.label, "timeout_s": String(transportSendDeadlineSeconds)
            ])
            finish(StudioSocketClosure(closeCode: nil, httpStatus: nil, reason: "send timed out"))
            throw StudioSocketError.sendTimedOut
        }
    }

    private func closure(of wsTask: RelayWebSocketTasking, error: Error) -> StudioSocketClosure {
        let rawCode = wsTask.closeCode.rawValue
        return StudioSocketClosure(
            closeCode: rawCode > 0 ? rawCode : nil,
            httpStatus: (wsTask.response as? HTTPURLResponse)?.statusCode,
            reason: error.localizedDescription
        )
    }

    private func finish(_ closure: StudioSocketClosure, closeCode: URLSessionWebSocketTask.CloseCode = .goingAway) {
        let (first, current, background) = lock.withLock { () -> (Bool, RelayWebSocketTasking?, [Task<Void, Never>]) in
            guard !didClose else { return (false, nil, []) }
            didClose = true
            let held = (task, [dialTask, keepaliveTask].compactMap { $0 })
            task = nil
            dialTask = nil
            keepaliveTask = nil
            return (true, held.0, held.1)
        }
        guard first else { return }
        background.forEach { $0.cancel() }
        current?.cancel(with: closeCode, reason: nil)
        taskFactory.invalidateAndCancel()
        DiagnosticLog.log("studio socket: closed", tag: "studio.socket", fields: [
            "route": routeKind.rawValue,
            "peer": options.label,
            "reason": closure.reason,
            "close_code": closure.closeCode.map(String.init) ?? "none",
            "http_status": closure.httpStatus.map(String.init) ?? "none"
        ])
        continuation.yield(.closed(closure))
        continuation.finish()
    }
}
