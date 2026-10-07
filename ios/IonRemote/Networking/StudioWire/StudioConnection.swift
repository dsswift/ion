import Foundation

/// One Studio wire connection to one environment, as a thin mobile client.
///
/// It owns the handshake (`studio_hello` → `studio_welcome`/`studio_refused`),
/// holds outbound frames until the welcome, correlates actions with their
/// results, and dials again when the connection drops. It never interprets an
/// event payload or an action's arguments: those belong to the layer above.
///
/// A `dial` closure supplies each attempt's socket and credential, so which
/// route a connection takes (`StudioRoute`) is decided outside it, per attempt.
actor StudioConnection {

    typealias Dial = @Sendable () async throws -> StudioDialPlan

    // MARK: - Streams

    /// Welcomes, events, snapshots, bodies, policy pushes, and binary frames, in arrival order.
    nonisolated let inbound: AsyncStream<StudioInbound>
    /// Every state change, in order.
    nonisolated let states: AsyncStream<StudioConnectionState>

    let inboundContinuation: AsyncStream<StudioInbound>.Continuation
    private let statesContinuation: AsyncStream<StudioConnectionState>.Continuation

    // MARK: - Configuration

    let clientId: String
    private let dial: Dial
    private let timing: StudioConnectionTiming

    // MARK: - State
    // Members without `private` are shared with `StudioConnection+Inbound.swift`.

    private(set) var state: StudioConnectionState = .idle
    /// The last welcome, kept so a caller that arrives late can read who it is connected as.
    var lastWelcome: StudioWelcome?

    var socket: (any StudioSocket)?
    var credential: StudioCredential?
    var welcomed = false
    var running = false
    /// Bumped for every dial and every teardown. Work that carries an older value is stale.
    var generation: UInt64 = 0
    var attempts = 0
    var windowStart: Date?

    private var pendingFrames: [StudioFrame] = []
    private var consumeTask: Task<Void, Never>?
    private var dialTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    var welcomeDeadlineTask: Task<Void, Never>?
    /// Sends run one after another so frames leave in the order they were given.
    private var sendChain: Task<Void, Never>?

    struct PendingAction {
        let action: String
        let completion: @Sendable (Result<JSONValue, Error>) -> Void
        let timeoutTask: Task<Void, Never>
        /// False while the action frame is still in `pendingFrames`.
        var sent: Bool
        /// Set on the frame's outer envelope when it is sent.
        var traceparent: String?
    }
    var pendingActions: [String: PendingAction] = [:]

    /// This client's own view of wire latency, reported once per window.
    /// Shared with `StudioConnection+Trace.swift`.
    lazy var latency = StudioClientLatency()
    private var latencyWindowTask: Task<Void, Never>?
    /// The `connection.connect` span of the attempt in flight, from the dial
    /// to the welcome or the failure. See `StudioConnection+Trace.swift`.
    var connectSpan: TraceSpan?

    // MARK: - Init

    init(clientId: String, timing: StudioConnectionTiming = .standard, dial: @escaping Dial) {
        self.clientId = clientId
        self.timing = timing
        self.dial = dial
        var inboundContinuation: AsyncStream<StudioInbound>.Continuation!
        self.inbound = AsyncStream { inboundContinuation = $0 }
        self.inboundContinuation = inboundContinuation
        var statesContinuation: AsyncStream<StudioConnectionState>.Continuation!
        self.states = AsyncStream { statesContinuation = $0 }
        self.statesContinuation = statesContinuation
    }

    deinit {
        inboundContinuation.finish()
        statesContinuation.finish()
    }

    // MARK: - Lifecycle

    /// Starts connecting. Does nothing when already started.
    func start() {
        guard !running else {
            DiagnosticLog.log("studio connection: start ignored, already running", tag: "studio.conn", level: .debug, fields: ["client_id": clientId])
            return
        }
        running = true
        attempts = 0
        windowStart = nil
        DiagnosticLog.log("studio connection: started", tag: "studio.conn", fields: ["client_id": clientId])
        startLatencyWindow()
        connect()
    }

    /// Stops for good: closes the socket, cancels the retry, and fails everything outstanding.
    func stop() {
        running = false
        teardown()
        failActions(where: { _ in true }) { .abandoned(action: $0.action) }
        dropPendingFrames(reason: "stopped by caller")
        DiagnosticLog.log("studio connection: stopped by caller", tag: "studio.conn", fields: ["client_id": clientId])
        // One last window: what this connection measured since the previous
        // one would otherwise go with it.
        latencyWindowTask?.cancel()
        latencyWindowTask = nil
        latency.flush()
        endConnectSpan(error: "stopped by caller")
        setState(.idle)
    }

    /// Write this client's latency window on a repeating timer.
    private func startLatencyWindow() {
        guard latencyWindowTask == nil else { return }
        latencyWindowTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(StudioClientLatency.windowInterval))
                } catch {
                    return // cancelled: stop() writes the final window
                }
                await self?.flushLatencyWindow()
            }
        }
    }

    /// Re-arms the retry ladder from zero and dials now. This is also the way
    /// out of `.refused` and `.closedByServer`, and how a caller moves the
    /// connection to a better route.
    func restart() {
        DiagnosticLog.log("studio connection: restart requested", tag: "studio.conn", fields: ["client_id": clientId])
        running = true
        teardown()
        failActions(where: \.sent) { .connectionLost(action: $0.action) }
        attempts = 0
        windowStart = nil
        connect()
    }

    // MARK: - Sending

    /// Sends one frame, or holds it until the welcome when the wire is not ready.
    func send(_ frame: StudioFrame) {
        guard welcomed, socket != nil else {
            enqueue(frame)
            return
        }
        transmit(frame)
    }

    /// Sends one binary frame. Binary frames are not queued: terminal bytes
    /// held across a reconnect would arrive out of context.
    @discardableResult
    func sendBinary(_ frame: StudioBinaryFrame) -> Bool {
        guard welcomed, let socket else {
            DiagnosticLog.log("studio connection: binary frame dropped, wire not ready", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId, "key": frame.key
            ])
            return false
        }
        let generation = generation
        chainSend(label: "binary") { [clientId] in
            do {
                try await socket.send(binary: try frame.encoded())
            } catch {
                DiagnosticLog.log("studio connection: binary send failed", tag: "studio.conn", level: .warn, fields: [
                    "client_id": clientId, "generation": String(generation), "error": error.localizedDescription
                ])
            }
        }
        return true
    }

    /// Runs one action and returns its value (`.null` when the result carried none).
    /// Throws `StudioActionFailure`.
    func sendAction(
        _ action: String,
        args: [JSONValue] = [],
        activeTabId: String? = nil,
        timeoutSeconds: Double? = nil,
        traceparent: String? = nil
    ) async throws -> JSONValue {
        try await withCheckedThrowingContinuation { continuation in
            submitAction(action, args: args, activeTabId: activeTabId, timeoutSeconds: timeoutSeconds, traceparent: traceparent) {
                continuation.resume(with: $0)
            }
        }
    }

    /// Hands one action to the wire and returns without waiting for its
    /// result, so a caller that submits several keeps their order and is
    /// never held up by a slow one. `completion` is called exactly once, with
    /// the value or a `StudioActionFailure`.
    func submitAction(
        _ action: String,
        args: [JSONValue] = [],
        activeTabId: String? = nil,
        timeoutSeconds: Double? = nil,
        traceparent: String? = nil,
        completion: @escaping @Sendable (Result<JSONValue, Error>) -> Void
    ) {
        let id = UUID().uuidString.lowercased()
        let seconds = timeoutSeconds ?? timing.actionTimeoutSeconds
        let timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(seconds))
            } catch {
                // Cancelled because the result arrived, or the action was failed another way.
                return
            }
            await self?.resolveAction(id: id, with: .failure(StudioActionFailure.timedOut(action: action, seconds: seconds)), why: "timed out")
        }
        pendingActions[id] = PendingAction(action: action, completion: completion, timeoutTask: timeoutTask, sent: false, traceparent: traceparent)
        // The round trip is timed from the socket write (`transmit`); from
        // here to there is queue time, reported on its own.
        latency.noteActionEnqueued(id: id)
        DiagnosticLog.log("studio connection: action sent", tag: "studio.conn", level: .debug, fields: [
            "client_id": clientId, "action": action, "action_id": id, "welcomed": String(welcomed)
        ])
        send(.action(StudioAction(id: id, action: action, args: args, activeTabId: activeTabId)))
    }

    /// Asks the server for its full snapshot again. It arrives as `.snapshot` on `inbound`.
    func requestSnapshot() {
        send(.snapshotRequest)
    }

    /// Asks for a conversation's transcript. It arrives as `.body` on `inbound`.
    func requestBody(_ request: StudioBodyRequest) {
        send(.bodyRequest(request))
    }

    // MARK: - Dialing

    private func connect() {
        generation &+= 1
        let generation = generation
        welcomed = false
        beginConnectSpan()
        setState(.connecting)
        dialTask = Task { [weak self, dial] in
            let plan: StudioDialPlan
            do {
                plan = try await dial()
            } catch {
                await self?.dialFailed(generation: generation, reason: "dial failed: \(error.localizedDescription)")
                return
            }
            guard let self else {
                plan.socket.close()
                return
            }
            await self.adopt(plan, generation: generation)
        }
        armWelcomeDeadline(generation: generation)
    }

    private func dialFailed(generation: UInt64, reason: String) {
        guard generation == self.generation, running else { return }
        handleFailure(reason: reason)
    }

    private func adopt(_ plan: StudioDialPlan, generation: UInt64) {
        guard generation == self.generation, running else {
            DiagnosticLog.log("studio connection: dial result discarded, superseded", tag: "studio.conn", fields: [
                "client_id": clientId, "generation": String(generation), "current_generation": String(self.generation)
            ])
            plan.socket.close()
            return
        }
        socket = plan.socket
        credential = plan.credential
        latency.noteRoute(plan.socket.routeKind)
        DiagnosticLog.log("studio connection: socket adopted", tag: "studio.conn", fields: [
            "client_id": clientId, "route": plan.socket.routeKind.rawValue, "credential_kind": plan.credential.kind
        ])
        let events = plan.socket.events
        consumeTask = Task { [weak self] in
            for await event in events {
                await self?.handle(event, generation: generation)
            }
        }
        plan.socket.open()
    }

    private func armWelcomeDeadline(generation: UInt64) {
        welcomeDeadlineTask?.cancel()
        let seconds = timing.welcomeDeadlineSeconds
        welcomeDeadlineTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(seconds))
            } catch {
                // Cancelled because the welcome arrived or the attempt ended another way.
                return
            }
            await self?.welcomeDeadlinePassed(generation: generation, seconds: seconds)
        }
    }

    private func welcomeDeadlinePassed(generation: UInt64, seconds: Double) {
        guard generation == self.generation, running, !welcomed else { return }
        handleFailure(reason: "no welcome within \(seconds)s")
    }

    // MARK: - Failure and retry

    func handleFailure(reason: String) {
        endConnectSpan(error: reason)
        teardown()
        guard running else { return }
        failActions(where: \.sent) { .connectionLost(action: $0.action) }
        let now = Date()
        if windowStart.map({ now.timeIntervalSince($0) > timing.backoffWindowSeconds }) ?? true {
            windowStart = now
            attempts = 0
        }
        attempts += 1
        let delay: Double
        if attempts > timing.maxAttempts {
            // Whatever was queued has waited out the whole ladder. Replaying it
            // minutes later would be a stale action, not the one the person asked for.
            dropPendingFrames(reason: reason)
            failActions(where: { !$0.sent }) { .abandoned(action: $0.action) }
            delay = timing.offlineRetrySeconds
            setState(.offline(reason: reason))
        } else {
            let ladder = timing.backoffLadderSeconds
            delay = ladder.isEmpty ? 0 : ladder[min(attempts - 1, ladder.count - 1)]
            setState(.backoff(attempt: attempts, delaySeconds: delay, reason: reason))
        }
        let generation = generation
        retryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                // Cancelled by stop(), restart(), or a teardown that superseded this retry.
                return
            }
            await self?.retryFired(generation: generation)
        }
    }

    private func retryFired(generation: UInt64) {
        guard generation == self.generation, running else { return }
        DiagnosticLog.log("studio connection: retry timer fired", tag: "studio.conn", fields: [
            "client_id": clientId, "attempt": String(attempts)
        ])
        connect()
    }

    func endWithoutRetry(_ terminal: StudioConnectionState, why: String) {
        running = false
        endConnectSpan(error: why)
        teardown()
        failActions(where: \.sent) { .connectionLost(action: $0.action) }
        failActions(where: { !$0.sent }) { .abandoned(action: $0.action) }
        dropPendingFrames(reason: why)
        setState(terminal)
    }

    /// Ends the current attempt: closes its socket and cancels its timers.
    /// Bumping the generation makes everything that attempt still reports stale.
    private func teardown() {
        generation &+= 1
        welcomed = false
        dialTask?.cancel()
        dialTask = nil
        retryTask?.cancel()
        retryTask = nil
        welcomeDeadlineTask?.cancel()
        welcomeDeadlineTask = nil
        consumeTask?.cancel()
        consumeTask = nil
        sendChain = nil
        socket?.close()
        socket = nil
    }

    // MARK: - Queue

    private func enqueue(_ frame: StudioFrame) {
        if pendingFrames.count >= timing.maxPendingFrames {
            let dropped = pendingFrames.removeFirst()
            DiagnosticLog.log("studio connection: pending queue full, dropped the oldest", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId, "dropped_frame_type": dropped.wireType, "queued": String(pendingFrames.count)
            ])
            if case .action(let action) = dropped {
                resolveAction(id: action.id, with: .failure(StudioActionFailure.abandoned(action: action.action)), why: "queue overflow")
            }
        }
        pendingFrames.append(frame)
        DiagnosticLog.log("studio connection: frame queued until the wire is ready", tag: "studio.conn", level: .debug, fields: [
            "client_id": clientId, "frame_type": frame.wireType, "queued": String(pendingFrames.count)
        ])
    }

    func flushPending() {
        guard !pendingFrames.isEmpty else { return }
        let queued = pendingFrames
        pendingFrames = []
        DiagnosticLog.log("studio connection: flushing frames queued while the wire came up", tag: "studio.conn", fields: [
            "client_id": clientId, "count": String(queued.count)
        ])
        queued.forEach(transmit)
    }

    private func dropPendingFrames(reason: String) {
        guard !pendingFrames.isEmpty else { return }
        DiagnosticLog.log("studio connection: discarding queued frames", tag: "studio.conn", level: .warn, fields: [
            "client_id": clientId, "count": String(pendingFrames.count), "reason": reason
        ])
        pendingFrames = []
    }

    func transmit(_ frame: StudioFrame) {
        guard let socket else { return }
        let text: String
        do {
            text = try frame.encodedText()
        } catch {
            DiagnosticLog.log("studio connection: frame did not encode, dropped", tag: "studio.conn", level: .error, fields: [
                "client_id": clientId, "frame_type": frame.wireType, "error": error.localizedDescription
            ])
            return
        }
        let traceparent: String?
        let actionId: String?
        if case .action(let action) = frame {
            pendingActions[action.id]?.sent = true
            traceparent = pendingActions[action.id]?.traceparent
            actionId = action.id
        } else {
            traceparent = nil
            actionId = nil
        }
        let wireType = frame.wireType
        chainSend(label: wireType) { [weak self, clientId] in
            if let actionId { await self?.noteActionWritten(id: actionId) }
            do {
                try await socket.send(text: text, traceparent: traceparent)
            } catch {
                // The socket reports its own close; the retry path starts from that.
                DiagnosticLog.log("studio connection: send failed", tag: "studio.conn", level: .warn, fields: [
                    "client_id": clientId, "frame_type": wireType, "error": error.localizedDescription
                ])
            }
        }
    }

    private func chainSend(label: String, _ operation: @escaping @Sendable () async -> Void) {
        let previous = sendChain
        sendChain = Task {
            await previous?.value
            await operation()
        }
    }

    // MARK: - Actions

    func resolveAction(id: String, with result: Result<JSONValue, Error>, why: String) {
        guard let pending = pendingActions.removeValue(forKey: id) else { return }
        pending.timeoutTask.cancel()
        // "timed out" is the one outcome that is not a measured round trip:
        // counted on its own rather than averaged in, where it would make the
        // wire look merely sluggish.
        if why == "timed out" {
            latency.noteActionTimeout(id: id)
        } else {
            latency.noteActionResult(id: id)
        }
        DiagnosticLog.log("studio connection: action resolved", tag: "studio.conn", level: .debug, fields: [
            "client_id": clientId, "action": pending.action, "action_id": id, "outcome": why
        ])
        pending.completion(result)
    }

    private func failActions(where matches: (PendingAction) -> Bool, with failure: (PendingAction) -> StudioActionFailure) {
        for (id, pending) in pendingActions where matches(pending) {
            resolveAction(id: id, with: .failure(failure(pending)), why: "connection")
        }
    }

    // MARK: - State

    func setState(_ next: StudioConnectionState) {
        guard next != state else { return }
        state = next
        DiagnosticLog.log("studio connection: state changed", tag: "studio.conn", fields: [
            "client_id": clientId, "state": String(describing: next)
        ])
        statesContinuation.yield(next)
    }
}
