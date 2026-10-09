import XCTest
@testable import IonRemote

/// The spans this phone writes about what a person waits for: the connect,
/// the snapshot and each transcript patch being applied, and the prompt's
/// answer becoming visible. Spans started inside the app are captured through
/// `TraceSpan.installWriter`, the test seam every default-writer span goes to.
@MainActor
final class ClientSpanTests: XCTestCase {

    private typealias T = TranscriptTestSupport

    private var written = Collected<TraceSpan.Record>()

    override func setUp() {
        super.setUp()
        written = Collected<TraceSpan.Record>()
        let sink = written
        TraceSpan.installWriter { sink.append($0) }
    }

    override func tearDown() {
        TraceSpan.resetWriter()
        TraceSpan.user = nil
        super.tearDown()
    }

    private func records(_ name: String) -> [TraceSpan.Record] { written.values.filter { $0.name == name } }

    // MARK: - connection.connect

    private let fastTiming = StudioConnectionTiming(
        backoffLadderSeconds: [0.02], maxAttempts: 5, backoffWindowSeconds: 60,
        offlineRetrySeconds: 0.05, welcomeDeadlineSeconds: 5, actionTimeoutSeconds: 5, maxPendingFrames: 8
    )

    func testTheConnectSpanRunsFromTheDialToTheWelcomeWithTheRouteAndEnvironment() async throws {
        let socket = FakeStudioSocket(routeKind: .relay)
        let dialer = FakeDialer(sockets: [socket])
        let connection = StudioConnection(clientId: "phone-1", timing: fastTiming, dial: dialer.dial)
        await connection.start()
        await waitUntil("hello is sent") { socket.sentFrames.count >= 1 }
        XCTAssertEqual(records("connection.connect"), [], "the span is open until the welcome")

        var welcome = StudioWelcome.fixture(environmentId: "env-42")
        welcome.principal = StudioPrincipalSummary(subject: "oidc:abc", displayName: "Josh", email: "josh@example.test")
        try socket.receive(.welcome(welcome))
        await waitUntil("connected") { await connection.state.isConnected }

        let record = try XCTUnwrap(records("connection.connect").first)
        XCTAssertEqual(record.kind, .client)
        XCTAssertEqual(record.attributes["route"], "relay")
        XCTAssertEqual(record.attributes["environment_id"], "env-42")
        XCTAssertEqual(record.attributes["peer.service"], "ion-server")
        XCTAssertEqual(record.attributes["attempt"], "1")
        XCTAssertNil(record.error)
        XCTAssertEqual(TraceSpan.user, "josh@example.test", "the welcome's person is every later span's user")
        await connection.stop()
    }

    func testAFailedAttemptClosesTheConnectSpanWithTheReason() async throws {
        let socket = FakeStudioSocket()
        let dialer = FakeDialer(sockets: [socket])
        let connection = StudioConnection(clientId: "phone-1", timing: fastTiming, dial: dialer.dial)
        await connection.start()
        await waitUntil("hello is sent") { socket.sentFrames.count >= 1 }
        socket.drop(reason: "network lost")
        await waitUntil("a failed connect span is written") { !self.records("connection.connect").isEmpty }
        let record = try XCTUnwrap(records("connection.connect").first)
        XCTAssertEqual(record.attributes["route"], "tcp")
        XCTAssertEqual(record.error, "connection closed: network lost")
        await connection.stop()
    }

    // MARK: - snapshot.apply

    func testTheSnapshotSpanWrapsTheSnapshotBeingApplied() throws {
        let vm = SessionViewModel()
        vm.handleEvent(.snapshot(tabs: [T.tab("t1"), T.tab("t2")], recentDirectories: [], availableModels: nil, customName: nil, customIcon: nil, remoteDisplayUpdatedAt: nil, resources: nil))
        let record = try XCTUnwrap(records("snapshot.apply").first)
        XCTAssertEqual(record.attributes["tabs"], "2")
        XCTAssertEqual(vm.tabs.map(\.id), ["t1", "t2"], "the span ends after the state is applied")
    }

    // MARK: - transcript.apply and prompt.visible

    private func opened(_ vm: SessionViewModel, _ tabId: String, rows: [Message]) {
        vm.tabs = [T.tab(tabId, status: .running)]
        vm.loadConversationIfNeeded(tabId: tabId)
        vm.handleTranscriptPage(T.page(tabId: tabId, rows: rows))
    }

    func testATranscriptPatchIsOneSpanWithItsKindAndOutcome() throws {
        let vm = SessionViewModel()
        opened(vm, "t", rows: [T.row("u1", .user, "hi")])
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [T.row("a1")])))
        var patch = T.patch(tabId: "t", baseRev: 5, total: 2, change: .append(index: 1, id: "a1", field: .content, text: "x"))
        patch.traceId = "4bf92f3577b34da6a3ce929d0e0e4736"
        patch.spanId = "00f067aa0ba902b7"
        vm.handleTranscriptPatch(patch)

        let spans = records("transcript.apply")
        XCTAssertEqual(spans.map { $0.attributes["kind"] }, ["splice", "append"])
        XCTAssertEqual(spans.map { $0.attributes["outcome"] }, ["applied", "resync:rev_gap"])
        XCTAssertEqual(spans[1].traceId, "4bf92f3577b34da6a3ce929d0e0e4736", "a frame with a trace joins it")
        XCTAssertEqual(spans[1].parentSpanId, "00f067aa0ba902b7")
        XCTAssertNil(spans[0].parentSpanId, "a frame without a trace, with no prompt waiting, is a root")
    }

    func testPromptVisibleRunsFromTheSubmitToTheAnswersFirstUpdateInTheSameTraceAsPromptSend() throws {
        let vm = SessionViewModel()
        opened(vm, "t", rows: [T.row("u0", .user, "earlier")])
        vm.submit(tabId: "t", text: "hello")
        let pending = try XCTUnwrap(vm.pendingPrompts["t"]?.first)
        XCTAssertEqual(ClientSpanBook.shared.openPromptCount, 1)

        // The server's row for the prompt itself does not end the wait.
        var echo = T.row(pending.id + "-row", .user, "hello")
        echo.clientMsgId = pending.id
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [echo])))
        XCTAssertEqual(records("prompt.visible"), [], "the person's own prompt is not the answer")

        // The first assistant row is.
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 1, total: 3, change: .splice(at: 2, deleteCount: 0, rows: [T.row("a1")])))
        let visible = try XCTUnwrap(records("prompt.visible").first)
        XCTAssertNil(visible.parentSpanId, "a second root of the prompt's trace")
        XCTAssertEqual(visible.attributes["client_msg_id"], pending.id)
        XCTAssertEqual(visible.attributes["joined_by"], "tab")
        XCTAssertEqual(ClientSpanBook.shared.openPromptCount, 0)

        // The patches that rendered the answer were children of the wait.
        let applies = records("transcript.apply")
        XCTAssertEqual(applies.count, 2)
        XCTAssertEqual(applies.map(\.traceId), [visible.traceId, visible.traceId])
        XCTAssertEqual(applies.map(\.parentSpanId), [visible.spanId, visible.spanId])

        // The prompt.send span of the same prompt shares the trace.
        vm.handlePromptResult(tabId: "t", clientMsgId: pending.id, status: "accepted", error: nil)
        let send = try XCTUnwrap(records("prompt.send").first)
        XCTAssertEqual(send.traceId, visible.traceId)
    }

    func testAnEngineTraceOnTheFrameJoinsThePromptItAnswers() throws {
        let vm = SessionViewModel()
        opened(vm, "t", rows: [])
        vm.submit(tabId: "t", text: "first")
        vm.submit(tabId: "t", text: "second")
        let second = try XCTUnwrap(vm.pendingPrompts["t"]?.last)
        let secondSend = try XCTUnwrap(ActionTraceBook.shared.close(key: second.id, accepted: true, error: nil))

        var patch = T.patch(tabId: "t", baseRev: 0, total: 1, change: .splice(at: 0, deleteCount: 0, rows: [T.row("a1")]))
        patch.traceId = secondSend.traceId
        patch.spanId = "00f067aa0ba902b7"
        vm.handleTranscriptPatch(patch)

        let visible = try XCTUnwrap(records("prompt.visible").first)
        XCTAssertEqual(visible.attributes["client_msg_id"], second.id, "the frame's trace picks the prompt, not the tab's oldest")
        XCTAssertEqual(visible.attributes["joined_by"], "trace_id")
        XCTAssertEqual(ClientSpanBook.shared.openPromptCount, 1)
        vm.forgetTranscript(tabId: "t")
        XCTAssertEqual(ClientSpanBook.shared.openPromptCount, 0, "a closed conversation abandons its waits")
        XCTAssertEqual(records("prompt.visible").last?.error, "conversation closed")
    }

    func testARefusedPromptEndsItsVisibleSpanFailed() throws {
        let vm = SessionViewModel()
        opened(vm, "t", rows: [])
        vm.submit(tabId: "t", text: "hello")
        let pending = try XCTUnwrap(vm.pendingPrompts["t"]?.first)
        vm.handlePromptResult(tabId: "t", clientMsgId: pending.id, status: "rejected", error: "locked")
        XCTAssertEqual(records("prompt.visible").first?.error, "locked")
        XCTAssertEqual(records("prompt.send").first?.error, "locked")
    }

    // MARK: - push.open and pairing.complete

    func testAPushOpenEndsWhenItsConversationIsOnScreen() throws {
        let book = ClientSpanBook()
        let parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        book.openPush(tabId: "t1", parent: parent)
        XCTAssertNil(book.tabVisible("other"))
        let record = try XCTUnwrap(book.tabVisible("t1"))
        XCTAssertEqual(record.name, "push.open")
        XCTAssertEqual(record.traceId, "4bf92f3577b34da6a3ce929d0e0e4736")
        XCTAssertEqual(record.parentSpanId, "00f067aa0ba902b7")
        XCTAssertEqual(book.openPushCount, 0)
    }

    func testPairingCompleteFollowsThePairingState() throws {
        let book = ClientSpanBook()
        XCTAssertNil(book.pairingStateChanged(from: .idle, to: .connecting(hostName: "mac")))
        XCTAssertNil(book.pairingStateChanged(from: .connecting(hostName: "mac"), to: .exchangingKeys))
        let paired = try XCTUnwrap(book.pairingStateChanged(from: .exchangingKeys, to: .paired))
        XCTAssertEqual(paired.name, "pairing.complete")
        XCTAssertEqual(paired.attributes["outcome"], "paired")
        XCTAssertNil(paired.error)

        XCTAssertNil(book.pairingStateChanged(from: .paired, to: .discovering))
        let failed = try XCTUnwrap(book.pairingStateChanged(from: .discovering, to: .failed(RelayPairingError.noReachableRelay)))
        XCTAssertEqual(failed.attributes["outcome"], "failed")
        XCTAssertNotNil(failed.error)
        XCTAssertNil(book.pairingStateChanged(from: .failed(RelayPairingError.noReachableRelay), to: .idle), "idle after a failure closes nothing twice")
    }

    // MARK: - app.launch

    func testAppLaunchIsARootFromTheProcessStartAndParentsTheFirstOfEachChildOnce() throws {
        let start = Date(timeIntervalSince1970: 1_000)
        let launch = AppLaunchTrace(processStart: start) { [written] in written.append($0) }
        let first = try XCTUnwrap(launch.parentForFirst("connection.connect"))
        XCTAssertNil(launch.parentForFirst("connection.connect"), "a reconnect is its own trace")
        XCTAssertNotNil(launch.parentForFirst("snapshot.apply"))
        let record = try XCTUnwrap(launch.sceneActive(at: start.addingTimeInterval(1.5)))
        XCTAssertNil(launch.sceneActive(), "later activations end nothing")
        XCTAssertEqual(record.name, "app.launch")
        XCTAssertNil(record.parentSpanId)
        XCTAssertEqual(record.durationMs, 1500)
        XCTAssertEqual(TraceContext.parse(first)?.traceId, record.traceId)
        XCTAssertLessThan(AppLaunchTrace.processStartDate(), Date(), "the kernel's start time is in the past")
    }
}
