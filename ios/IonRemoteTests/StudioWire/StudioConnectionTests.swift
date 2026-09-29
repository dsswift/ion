import XCTest
@testable import IonRemote

/// `StudioConnection` against a socket the test drives: the handshake, the
/// pre-welcome queue, action correlation, and what each kind of ending does.
final class StudioConnectionTests: XCTestCase {

    private let fastTiming = StudioConnectionTiming(
        backoffLadderSeconds: [0.02],
        maxAttempts: 5,
        backoffWindowSeconds: 60,
        offlineRetrySeconds: 0.05,
        welcomeDeadlineSeconds: 5,
        actionTimeoutSeconds: 5,
        maxPendingFrames: 8
    )

    private struct Harness {
        let connection: StudioConnection
        let dialer: FakeDialer
        let states: Collected<StudioConnectionState>
        let inbound: Collected<StudioInbound>
    }

    private func makeHarness(sockets: [FakeStudioSocket], timing: StudioConnectionTiming? = nil) -> Harness {
        let dialer = FakeDialer(sockets: sockets)
        let connection = StudioConnection(clientId: "phone-1", timing: timing ?? fastTiming, dial: dialer.dial)
        let states = Collected<StudioConnectionState>()
        let inbound = Collected<StudioInbound>()
        Task { for await state in connection.states { states.append(state) } }
        Task { for await item in connection.inbound { inbound.append(item) } }
        return Harness(connection: connection, dialer: dialer, states: states, inbound: inbound)
    }

    private func welcome(_ socket: FakeStudioSocket, _ harness: Harness) async throws {
        await waitUntil("hello is sent") { socket.sentFrames.count >= 1 }
        try socket.receive(.welcome(.fixture()))
        await waitUntil("connected") { await harness.connection.state.isConnected }
    }

    // MARK: - Handshake

    func testHelloIsTheFirstFrameAndAsksForTheThinView() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        await waitUntil("hello is sent") { socket.sentFrames.count == 1 }
        XCTAssertEqual(socket.sentFrames, [
            .hello(StudioHello(protocolVersion: 1, clientId: "phone-1", clientKind: "mobile", capabilities: [studioWirePingCapability],
                               credential: .paired(clientId: "phone-1", proof: "cHJvb2Y="), view: "thin"))
        ])
        await harness.connection.stop()
    }

    func testFramesAreHeldUntilTheWelcomeThenSentInOrder() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.requestSnapshot()
        await harness.connection.start()
        await harness.connection.requestBody(StudioBodyRequest(tabId: "tab-1", instanceId: nil, before: nil, limit: 50))
        await waitUntil("hello is sent") { socket.sentFrames.count == 1 }
        // Give a wrongly released frame the chance to show up.
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(socket.sentFrames.map(\.wireType), ["studio_hello"])

        try socket.receive(.welcome(.fixture(environmentId: "env-7")))
        await waitUntil("queue is flushed") { socket.sentFrames.count == 3 }
        XCTAssertEqual(socket.sentFrames.map(\.wireType), ["studio_hello", "studio_snapshot_request", "studio_body_request"])
        XCTAssertEqual(harness.states.values, [.connecting, .connected(route: .tcp, environmentId: "env-7")])
        XCTAssertEqual(harness.inbound.values.first, .welcome(.fixture(environmentId: "env-7")))
        await harness.connection.stop()
    }

    func testEventsSnapshotsAndBodiesReachTheOwnerInOrder() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        try await welcome(socket, harness)
        let event = StudioEvent(channel: studioThinEventChannel, payload: .object(["type": .string("desktop_heartbeat")]))
        let body = StudioBody(tabId: "tab-1", instanceId: nil, rows: [], hasMore: false, cursor: nil, anchor: .newest)
        try socket.receive(.event(event))
        try socket.receive(.snapshot(.object(["tabs": .array([])])))
        try socket.receive(.body(body))
        await waitUntil("all three arrive") { harness.inbound.values.count == 4 }
        XCTAssertEqual(Array(harness.inbound.values.dropFirst()), [.event(event), .snapshot(.object(["tabs": .array([])])), .body(body)])
        await harness.connection.stop()
    }

    // MARK: - Actions

    func testActionResultsAreMatchedByIdNotByOrder() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        try await welcome(socket, harness)

        async let first = harness.connection.sendAction("selectTab", args: [.string("tab-1")], activeTabId: "tab-9")
        async let second = harness.connection.sendAction("listTabs")
        await waitUntil("both actions are on the wire") { socket.sentFrames.count == 3 }
        let actions = socket.sentFrames.compactMap { frame -> StudioAction? in
            if case .action(let action) = frame { return action }
            return nil
        }
        let select = try XCTUnwrap(actions.first { $0.action == "selectTab" })
        let list = try XCTUnwrap(actions.first { $0.action == "listTabs" })
        XCTAssertEqual(select.args, [.string("tab-1")])
        XCTAssertEqual(select.activeTabId, "tab-9")

        try socket.receive(.actionResult(StudioActionResult(id: list.id, ok: true, value: .array([.string("tab-1")]), refusal: nil, error: nil)))
        try socket.receive(.actionResult(StudioActionResult(id: "someone-else", ok: true, value: .int(1), refusal: nil, error: nil)))
        try socket.receive(.actionResult(StudioActionResult(id: select.id, ok: true, value: nil, refusal: nil, error: nil)))
        let (firstValue, secondValue) = try await (first, second)
        XCTAssertEqual(firstValue, .null)
        XCTAssertEqual(secondValue, .array([.string("tab-1")]))
        await harness.connection.stop()
    }

    func testAnActionsTraceparentRidesOnlyItsOwnFramesEnvelope() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        try await welcome(socket, harness)
        let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        await harness.connection.submitAction("session.prompt", args: [.object(["tabId": .string("t1")])], traceparent: traceparent) { _ in }
        await harness.connection.submitAction("listTabs") { _ in }
        await waitUntil("both actions are on the wire") { socket.sentFrames.count == 3 }
        // hello, then the prompt with its trace, then an untraced action.
        XCTAssertEqual(socket.sentTraceparents, [nil, traceparent, nil])
        await harness.connection.stop()
    }

    func testRefusalAndErrorResultsThrowDistinctFailures() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        try await welcome(socket, harness)

        async let refused = Result<JSONValue, Error>.catching { try await harness.connection.sendAction("landWorktree") }
        await waitUntil("action sent") { socket.sentFrames.count == 2 }
        guard case .action(let first) = socket.sentFrames[1] else { return XCTFail("not an action") }
        try socket.receive(.actionResult(StudioActionResult(id: first.id, ok: false, value: nil,
                                                            refusal: StudioActionFault(code: "scope", message: "needs git:write"), error: nil)))
        let outcome1 = await refused.failure as? StudioActionFailure
        XCTAssertEqual(outcome1, .refused(code: "scope", message: "needs git:write"))

        async let failed = Result<JSONValue, Error>.catching { try await harness.connection.sendAction("explode") }
        await waitUntil("action sent") { socket.sentFrames.count == 3 }
        guard case .action(let second) = socket.sentFrames[2] else { return XCTFail("not an action") }
        try socket.receive(.actionResult(StudioActionResult(id: second.id, ok: false, value: nil, refusal: nil,
                                                            error: StudioActionFault(code: "internal", message: "boom"))))
        let outcome2 = await failed.failure as? StudioActionFailure
        XCTAssertEqual(outcome2, .failed(code: "internal", message: "boom"))
        await harness.connection.stop()
    }

    func testAnActionWithNoResultTimesOut() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        try await welcome(socket, harness)
        let result = await Result<JSONValue, Error>.catching {
            try await harness.connection.sendAction("neverAnswers", timeoutSeconds: 0.05)
        }
        XCTAssertEqual(result.failure as? StudioActionFailure, .timedOut(action: "neverAnswers", seconds: 0.05))
        await harness.connection.stop()
    }

    // MARK: - Refusals and closes

    func testAnUnauthorizedRefusalSurfacesItsReasonAndStopsDialing() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket, FakeStudioSocket()])
        await harness.connection.start()
        await waitUntil("hello is sent") { socket.sentFrames.count == 1 }
        let refused = StudioRefused(reason: .unauthorized, detail: "pairing revoked", requiredProtocolVersion: nil)
        try socket.receive(.refused(refused))
        await waitUntil("refused state") { await harness.connection.state == .refused(refused) }
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(harness.dialer.dialCount, 1, "a refused credential must not be presented again")
        XCTAssertTrue(socket.isClosed)
        XCTAssertEqual(harness.states.values.last, .refused(refused))
    }

    func testANotReadyRefusalIsRetried() async throws {
        let first = FakeStudioSocket()
        let second = FakeStudioSocket()
        let harness = makeHarness(sockets: [first, second])
        await harness.connection.start()
        await waitUntil("hello is sent") { first.sentFrames.count == 1 }
        try first.receive(.refused(StudioRefused(reason: .notReady, detail: nil, requiredProtocolVersion: nil)))
        await waitUntil("second dial says hello") { second.sentFrames.count == 1 }
        XCTAssertEqual(harness.states.values.dropFirst().first, .backoff(attempt: 1, delaySeconds: 0.02, reason: "refused: not_ready"))
        await harness.connection.stop()
    }

    func testRevokedAndDisplacedClosesEndTheConnectionAndShutdownDoesNot() async throws {
        for reason in [StudioCloseReason.revoked, .displaced] {
            let socket = FakeStudioSocket()
            let harness = makeHarness(sockets: [socket, FakeStudioSocket()])
            await harness.connection.start()
            try await welcome(socket, harness)
            let close = StudioClose(reason: reason, detail: nil)
            try socket.receive(.close(close))
            await waitUntil("\(reason.wire) ends the connection") { await harness.connection.state == .closedByServer(close) }
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(harness.dialer.dialCount, 1, "\(reason.wire) must not reconnect")
        }

        let first = FakeStudioSocket()
        let second = FakeStudioSocket()
        let harness = makeHarness(sockets: [first, second])
        await harness.connection.start()
        try await welcome(first, harness)
        try first.receive(.close(StudioClose(reason: .shutdown, detail: "restarting")))
        await waitUntil("reconnects after a shutdown close") { second.sentFrames.count == 1 }
        XCTAssertTrue(harness.states.values.contains(.backoff(attempt: 1, delaySeconds: 0.02, reason: "closed by server: shutdown (restarting)")))
        await harness.connection.stop()
    }

    // MARK: - Reconnect

    func testADropReconnectsFailsInFlightActionsAndKeepsQueuedOnes() async throws {
        let first = FakeStudioSocket()
        let second = FakeStudioSocket(routeKind: .relay)
        let harness = makeHarness(sockets: [first, second])
        await harness.connection.start()
        try await welcome(first, harness)

        async let inFlight = Result<JSONValue, Error>.catching { try await harness.connection.sendAction("sendPrompt") }
        await waitUntil("action sent") { first.sentFrames.count == 2 }
        first.drop()
        let outcome3 = await inFlight.failure as? StudioActionFailure
        XCTAssertEqual(outcome3, .connectionLost(action: "sendPrompt"))

        // Asked for while the wire is down: held, then sent on the next connection.
        async let queued = harness.connection.sendAction("listTabs")
        await waitUntil("second dial says hello") { second.sentFrames.count == 1 }
        XCTAssertEqual(second.sentFrames.map(\.wireType), ["studio_hello"])
        try second.receive(.welcome(.fixture()))
        await waitUntil("queued action is sent") { second.sentFrames.count == 2 }
        guard case .action(let action) = second.sentFrames[1] else { return XCTFail("not an action") }
        try second.receive(.actionResult(StudioActionResult(id: action.id, ok: true, value: .bool(true), refusal: nil, error: nil)))
        let queuedValue = try await queued
        XCTAssertEqual(queuedValue, .bool(true))

        XCTAssertEqual(harness.states.values, [
            .connecting,
            .connected(route: .tcp, environmentId: "env-1"),
            .backoff(attempt: 1, delaySeconds: 0.02, reason: "connection closed: network lost"),
            .connecting,
            .connected(route: .relay, environmentId: "env-1")
        ])
        XCTAssertEqual(harness.inbound.values.filter { if case .welcome = $0 { return true } else { return false } }.count, 2)
        await harness.connection.stop()
    }

    func testTheLateCloseOfAReplacedSocketDoesNotTouchTheNewOne() async throws {
        let first = FakeStudioSocket()
        let second = FakeStudioSocket()
        let harness = makeHarness(sockets: [first, second])
        await harness.connection.start()
        try await welcome(first, harness)
        await harness.connection.restart()
        try await welcome(second, harness)
        XCTAssertTrue(first.isClosed)
        // `first` already reported its close; the connection must still be up on `second`.
        try await Task.sleep(for: .milliseconds(60))
        let state = await harness.connection.state
        XCTAssertTrue(state.isConnected)
        XCTAssertEqual(harness.dialer.dialCount, 2)
        await harness.connection.stop()
    }

    func testAWelcomeThatNeverComesCountsAsAFailure() async throws {
        var timing = fastTiming
        timing.welcomeDeadlineSeconds = 0.05
        let silent = FakeStudioSocket()
        let second = FakeStudioSocket()
        let harness = makeHarness(sockets: [silent, second], timing: timing)
        await harness.connection.start()
        await waitUntil("second dial says hello") { second.sentFrames.count == 1 }
        XCTAssertTrue(silent.isClosed)
        XCTAssertTrue(harness.states.values.contains(.backoff(attempt: 1, delaySeconds: 0.02, reason: "no welcome within 0.05s")))
        await harness.connection.stop()
    }

    func testAnExhaustedLadderGoesOfflineDropsTheQueueAndKeepsTrying() async throws {
        var timing = fastTiming
        timing.maxAttempts = 2
        // Two dials fail outright (no socket), the third is refused nothing: it connects.
        let eventual = FakeStudioSocket()
        let dialer = FailingThenDialer(failures: 3, socket: eventual)
        let connection = StudioConnection(clientId: "phone-1", timing: timing, dial: dialer.dial)
        let states = Collected<StudioConnectionState>()
        Task { for await state in connection.states { states.append(state) } }

        async let abandoned = Result<JSONValue, Error>.catching { try await connection.sendAction("listTabs") }
        await connection.start()
        let outcome4 = await abandoned.failure as? StudioActionFailure
        XCTAssertEqual(outcome4, .abandoned(action: "listTabs"))
        await waitUntil("still dials after going offline") { eventual.sentFrames.count == 1 }
        XCTAssertTrue(states.values.contains { if case .offline = $0 { return true } else { return false } })
        XCTAssertEqual(eventual.sentFrames.map(\.wireType), ["studio_hello"], "the abandoned action must not be replayed")
        await connection.stop()
    }

    func testStopFailsWhatIsOutstandingAndGoesIdle() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        try await welcome(socket, harness)
        async let pending = Result<JSONValue, Error>.catching { try await harness.connection.sendAction("slow") }
        await waitUntil("action sent") { socket.sentFrames.count == 2 }
        await harness.connection.stop()
        let outcome5 = await pending.failure as? StudioActionFailure
        XCTAssertEqual(outcome5, .abandoned(action: "slow"))
        let state = await harness.connection.state
        XCTAssertEqual(state, .idle)
        XCTAssertTrue(socket.isClosed)
    }

    func testAReverseCommandIsDeclinedRatherThanLeftToTimeOut() async throws {
        let socket = FakeStudioSocket()
        let harness = makeHarness(sockets: [socket])
        await harness.connection.start()
        try await welcome(socket, harness)
        try socket.receive(.command(StudioCommand(id: "cmd-1", command: "graph.fit", args: .object([:]), timeoutMs: 1000)))
        await waitUntil("the command is answered") { socket.sentFrames.count == 2 }
        XCTAssertEqual(socket.sentFrames[1], .commandResult(StudioCommandResult(id: "cmd-1", ok: false, value: nil, error: "this client answers no reverse commands")))
        await harness.connection.stop()
    }
}

/// A dial that throws a set number of times before handing out its socket.
private final class FailingThenDialer: @unchecked Sendable {
    private let lock = NSLock()
    private var failures: Int
    private let socket: FakeStudioSocket

    init(failures: Int, socket: FakeStudioSocket) {
        self.failures = failures
        self.socket = socket
    }

    var dial: StudioConnection.Dial {
        { [self] in
            let fail = lock.withLock { () -> Bool in
                guard failures > 0 else { return false }
                failures -= 1
                return true
            }
            if fail { throw StudioRouteError.unreachable(host: "test") }
            return StudioDialPlan(socket: socket, credential: .paired(clientId: "phone-1", proof: "p"))
        }
    }
}

private extension Result where Failure == Error {
    static func catching(_ body: () async throws -> Success) async -> Result {
        do {
            return .success(try await body())
        } catch {
            return .failure(error)
        }
    }

    var failure: Error? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
