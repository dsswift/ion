import XCTest
@testable import IonRemote

/// A connection the test drives by hand and whose calls it records.
final class FakeStudioConnection: StudioConnecting, @unchecked Sendable {

    struct Submitted: Equatable {
        let action: String
        let args: [JSONValue]
        let activeTabId: String?
    }

    let inbound: AsyncStream<StudioInbound>
    let states: AsyncStream<StudioConnectionState>
    private let inboundContinuation: AsyncStream<StudioInbound>.Continuation
    private let statesContinuation: AsyncStream<StudioConnectionState>.Continuation

    private let lock = NSLock()
    private var submitted: [Submitted] = []
    private var traceparents: [String?] = []
    private var bodies: [StudioBodyRequest] = []
    private var snapshots = 0
    private var starts = 0
    private var stops = 0
    private var restarts = 0
    /// What each action answers, by name. An action with no entry answers `.null`.
    private var outcomes: [String: Result<JSONValue, Error>] = [:]

    init() {
        var inboundContinuation: AsyncStream<StudioInbound>.Continuation!
        inbound = AsyncStream { inboundContinuation = $0 }
        self.inboundContinuation = inboundContinuation
        var statesContinuation: AsyncStream<StudioConnectionState>.Continuation!
        states = AsyncStream { statesContinuation = $0 }
        self.statesContinuation = statesContinuation
    }

    func deliver(_ inbound: StudioInbound) { inboundContinuation.yield(inbound) }
    func become(_ state: StudioConnectionState) { statesContinuation.yield(state) }
    func answer(_ action: String, with outcome: Result<JSONValue, Error>) { lock.withLock { outcomes[action] = outcome } }

    var submittedActions: [Submitted] { lock.withLock { submitted } }
    /// The envelope traceparent each submitted action carried, in order.
    var submittedTraceparents: [String?] { lock.withLock { traceparents } }
    var bodyRequests: [StudioBodyRequest] { lock.withLock { bodies } }
    var snapshotRequests: Int { lock.withLock { snapshots } }
    var startCount: Int { lock.withLock { starts } }
    var stopCount: Int { lock.withLock { stops } }
    var restartCount: Int { lock.withLock { restarts } }

    func start() async { lock.withLock { starts += 1 } }
    func stop() async { lock.withLock { stops += 1 } }
    func restart() async { lock.withLock { restarts += 1 } }
    func requestSnapshot() async { lock.withLock { snapshots += 1 } }
    func requestBody(_ request: StudioBodyRequest) async { lock.withLock { bodies.append(request) } }

    func sendAction(_ action: String, args: [JSONValue], activeTabId: String?, timeoutSeconds: Double?) async throws -> JSONValue {
        try record(action, args: args, activeTabId: activeTabId).get()
    }

    func submitAction(
        _ action: String, args: [JSONValue], activeTabId: String?, timeoutSeconds: Double?, traceparent: String?,
        completion: @escaping @Sendable (Result<JSONValue, Error>) -> Void
    ) async {
        lock.withLock { traceparents.append(traceparent) }
        completion(record(action, args: args, activeTabId: activeTabId))
    }

    private func record(_ action: String, args: [JSONValue], activeTabId: String?) -> Result<JSONValue, Error> {
        lock.withLock {
            submitted.append(Submitted(action: action, args: args, activeTabId: activeTabId))
            return outcomes[action] ?? .success(.null)
        }
    }
}

/// A mapping with one action whose outcome becomes a recognisable event.
private struct EchoMapping: StudioCommandMapping {
    func request(for command: RemoteCommand) -> StudioCommandRequest? {
        if case .unpair = command { return .action(StudioActionCall(action: "echo.primary"), followUps: [StudioActionCall(action: "echo.followUp")]) }
        return nil
    }

    func events(for command: RemoteCommand, call: StudioActionCall, result: JSONValue) -> [RemoteEvent] {
        [.transcript(tabId: "result", requestId: result.stringValue ?? "", transcript: "", error: nil)]
    }

    func events(for command: RemoteCommand, call: StudioActionCall, failure: StudioActionFailure) -> [RemoteEvent] {
        [.transcript(tabId: "failure", requestId: "", transcript: "", error: failure.localizedDescription)]
    }
}

final class StudioTransportTests: XCTestCase {

    /// Every transport a test built. Nothing else holds one — the fake
    /// connection has no reference back — so a test that binds it to `_` would
    /// have it deallocated while the test waits, and its inbound and state
    /// tasks cancelled. Three tests failed exactly that way.
    private var liveTransports: [StudioTransport] = []

    override func tearDown() {
        for transport in liveTransports { transport.stop() }
        liveTransports = []
        super.tearDown()
    }

    private func makeTransport(
        mapping: any StudioCommandMapping = StudioTransportCommandMapping(),
        decodeResyncSpacingSeconds: TimeInterval = 30
    ) async -> (StudioTransport, FakeStudioConnection, Collected<String>) {
        let connection = FakeStudioConnection()
        let transport = StudioTransport(deviceId: "device-1", connection: connection, mapping: mapping, decodeResyncSpacingSeconds: decodeResyncSpacingSeconds)
        let seen = Collected<String>()
        let events = transport.events
        Task {
            for await event in events { seen.append(Self.label(event)) }
        }
        await transport.start()
        liveTransports.append(transport)
        return (transport, connection, seen)
    }

    /// A short name for the events these tests look for.
    private static func label(_ event: RemoteEvent) -> String {
        switch event {
        case .transportReconnecting: return "transport_reconnecting"
        case .peerDisconnected: return "peer_disconnected"
        case .lanAuthRejected: return "lan_auth_rejected"
        case .unpair: return "unpair"
        case .transcript(let tabId, let requestId, _, let error): return "transcript:\(tabId):\(requestId):\(error ?? "")"
        default: return event.typeKey
        }
    }

    // MARK: - State

    func testStartStartsTheConnectionOnce() async {
        let (transport, connection, _) = await makeTransport()
        await transport.start()
        XCTAssertEqual(connection.startCount, 1)
    }

    func testTheRouteOfAConnectedStateBecomesTheTransportState() async {
        let (transport, connection, _) = await makeTransport()
        XCTAssertEqual(transport.state, .disconnected)

        connection.become(.connected(route: .tcp, environmentId: "env-1"))
        await waitUntil("direct route shows as lan") { transport.state == .lanPreferred }
        XCTAssertFalse(transport.relayIsConnected)

        connection.become(.connected(route: .relay, environmentId: "env-1"))
        await waitUntil("relay route shows as relay") { transport.state == .relayOnly }
        XCTAssertTrue(transport.relayIsConnected)
    }

    func testBackoffIsAReconnectAndOfflineIsALostPeer() async {
        let (transport, connection, seen) = await makeTransport()
        connection.become(.connected(route: .tcp, environmentId: "env-1"))
        connection.become(.backoff(attempt: 1, delaySeconds: 1, reason: "network lost"))
        await waitUntil("reconnecting event") { seen.values == ["transport_reconnecting"] }
        XCTAssertEqual(transport.state, .disconnected)

        connection.become(.offline(reason: "network lost"))
        await waitUntil("peer disconnected event") { seen.values == ["transport_reconnecting", "peer_disconnected"] }
    }

    func testARejectedCredentialSurfacesAsAnAuthRejectionThatIsFinal() async {
        let (transport, connection, seen) = await makeTransport()
        connection.become(.refused(StudioRefused(reason: .unauthorized, detail: nil, requiredProtocolVersion: nil)))
        await waitUntil("auth rejected event") { seen.values == ["lan_auth_rejected"] }
        XCTAssertTrue(transport.authRejectionIsFinal)
        XCTAssertEqual(transport.state, .disconnected)
    }

    func testARevokedPairingSurfacesAsUnpair() async {
        let (_, connection, seen) = await makeTransport()
        connection.become(.closedByServer(StudioClose(reason: .revoked, detail: nil)))
        await waitUntil("unpair event") { seen.values == ["unpair"] }
    }

    func testOtherTerminalStatesAreALostPeerNotARejectedPairing() {
        let refusals: [StudioRefusalReason] = [.protocolVersion, .scope, .unknown("later")]
        for reason in refusals {
            let (state, event) = StudioTransport.translate(.refused(StudioRefused(reason: reason, detail: nil, requiredProtocolVersion: nil)))
            XCTAssertEqual(state, .disconnected)
            XCTAssertEqual(event.map(Self.label), "peer_disconnected", reason.wire)
        }
        let (_, displaced) = StudioTransport.translate(.closedByServer(StudioClose(reason: .displaced, detail: nil)))
        XCTAssertEqual(displaced.map(Self.label), "peer_disconnected")
        XCTAssertNil(StudioTransport.translate(.connecting).1)
        XCTAssertNil(StudioTransport.translate(.idle).1)
    }

    // MARK: - Commands

    func testSyncAsksForTheSnapshotAgain() async throws {
        let (transport, connection, _) = await makeTransport()
        try await transport.send(.sync)
        XCTAssertEqual(connection.snapshotRequests, 1)
        XCTAssertTrue(connection.submittedActions.isEmpty)
    }

    func testResendAndIdentityReportsSendNothing() async throws {
        let (transport, connection, _) = await makeTransport()
        try await transport.send(.requestResend(fromSeq: 4, toSeq: 9))
        try await transport.send(.desktopAuth(token: "token-1"))
        XCTAssertEqual(connection.snapshotRequests, 0)
        XCTAssertTrue(connection.submittedActions.isEmpty)
        XCTAssertTrue(connection.bodyRequests.isEmpty)
    }

    func testFocusOnATabReportsFocusThenMarksTheTabRead() async throws {
        let (transport, connection, _) = await makeTransport()
        try await transport.send(.reportFocus(tabId: "tab-1", interceptEnabled: true))
        XCTAssertEqual(connection.submittedActions, [
            .init(action: "presence.focus", args: [.string("tab-1"), .null, .object(["interceptEnabled": .bool(true)])], activeTabId: nil),
            .init(action: "markTabRead", args: [.string("tab-1")], activeTabId: nil)
        ])
    }

    func testFocusOnNoTabReportsOnlyFocus() async throws {
        let (transport, connection, _) = await makeTransport()
        try await transport.send(.reportFocus(tabId: nil, interceptEnabled: false))
        XCTAssertEqual(connection.submittedActions, [
            .init(action: "presence.focus", args: [.null, .null, .object(["interceptEnabled": .bool(false)])], activeTabId: nil)
        ])
    }

    func testUnpairForgetsThisClientsOwnPairing() async throws {
        let (transport, connection, _) = await makeTransport()
        try await transport.send(.unpair)
        XCTAssertEqual(connection.submittedActions, [.init(action: "auth.forgetSelf", args: [], activeTabId: nil)])
    }

    func testLoadConversationBecomesAPagedBodyRequest() async throws {
        let (transport, connection, _) = await makeTransport()
        try await transport.send(.loadConversation(tabId: "tab-1", before: nil, pageSize: 40))
        try await transport.send(.loadConversation(tabId: "tab-1", before: "m-9", pageSize: nil))
        XCTAssertEqual(connection.bodyRequests, [
            StudioBodyRequest(tabId: "tab-1", instanceId: nil, before: nil, limit: 40),
            StudioBodyRequest(tabId: "tab-1", instanceId: nil, before: "m-9", limit: StudioTransportCommandMapping.defaultHistoryPageSize)
        ])
    }

    func testACommandWithNoMappingSendsNothingAndYieldsNothing() async throws {
        // `EchoMapping` answers only `.unpair`, standing in for a mapping that
        // has no entry for a command. The shipped table answers every command,
        // which is what `StudioCommandMapTests` pins.
        let (transport, connection, seen) = await makeTransport(mapping: EchoMapping())
        try await transport.send(.closeTab(tabId: "tab-1"))
        XCTAssertTrue(connection.submittedActions.isEmpty)
        XCTAssertEqual(connection.snapshotRequests, 0)
        XCTAssertTrue(connection.bodyRequests.isEmpty)
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(seen.values.isEmpty)
    }

    func testThePrimaryActionsValueBecomesTheMappingsEvents() async throws {
        let (transport, connection, seen) = await makeTransport(mapping: EchoMapping())
        connection.answer("echo.primary", with: .success(.string("value-1")))
        connection.answer("echo.followUp", with: .success(.string("ignored")))
        try await transport.send(.unpair)
        await waitUntil("result event") { seen.values == ["transcript:result:value-1:"] }
        XCTAssertEqual(connection.submittedActions.map(\.action), ["echo.primary", "echo.followUp"])
    }

    func testAFailedPrimaryActionBecomesTheMappingsFailureEventsAndFollowUpsStillRun() async throws {
        let (transport, connection, seen) = await makeTransport(mapping: EchoMapping())
        connection.answer("echo.primary", with: .failure(StudioActionFailure.refused(code: "scope", message: "not allowed")))
        connection.answer("echo.followUp", with: .failure(StudioActionFailure.timedOut(action: "echo.followUp", seconds: 1)))
        try await transport.send(.unpair)
        await waitUntil("failure event") { seen.values == ["transcript:failure::not allowed"] }
        XCTAssertEqual(connection.submittedActions.map(\.action), ["echo.primary", "echo.followUp"])
    }

    // MARK: - Inbound

    func testThinEventsAndBodiesReachTheEventStream() async throws {
        let (_, connection, seen) = await makeTransport()
        let payload = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"desktop_theme_manifest","themes":[],"hash":"h"}"#.utf8))
        connection.deliver(.event(StudioEvent(channel: studioThinEventChannel, payload: payload)))
        connection.deliver(.body(StudioBody(tabId: "tab-1", instanceId: nil, rows: [], hasMore: false, cursor: nil, anchor: .newest)))
        await waitUntil("both events") { seen.values == ["desktop_theme_manifest", "transcript_unavailable"] }
    }

    func testADecodeFailureAsksForOneResyncNotOnePerFailure() async throws {
        let (_, connection, _) = await makeTransport()
        let broken: JSONValue = .object(["type": .string("desktop_theme_manifest")])
        connection.deliver(.event(StudioEvent(channel: studioThinEventChannel, payload: broken)))
        connection.deliver(.event(StudioEvent(channel: studioThinEventChannel, payload: broken)))
        await waitUntil("a resync") { connection.snapshotRequests == 1 }
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(connection.snapshotRequests, 1)
    }

    func testAWelcomeIsHandedToTheOwner() async {
        let connection = FakeStudioConnection()
        let welcomes = Collected<String>()
        let transport = StudioTransport(deviceId: "device-1", connection: connection, onWelcome: { welcomes.append($0.environmentId) })
        await transport.start()
        connection.deliver(.welcome(StudioWelcome.fixture(environmentId: "env-7")))
        await waitUntil("welcome handed over") { welcomes.values == ["env-7"] }
    }

    // MARK: - Stop

    func testStopStopsTheConnectionAndRefusesFurtherCommands() async {
        let (transport, connection, _) = await makeTransport()
        transport.stop()
        await waitUntil("connection stopped") { connection.stopCount == 1 }
        XCTAssertEqual(transport.state, .disconnected)
        do {
            try await transport.send(.sync)
            XCTFail("a stopped transport accepted a command")
        } catch {
            XCTAssertEqual(error as? StudioTransportError, .stopped)
        }
        XCTAssertEqual(connection.snapshotRequests, 0)
    }
}
