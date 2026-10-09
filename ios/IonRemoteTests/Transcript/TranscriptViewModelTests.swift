import XCTest
@testable import IonRemote

/// The view model as the one writer of a conversation's rows: it opens the
/// stream, applies what the server sends, re-fetches on any gap, and shows the
/// phone's own prompt only until the server's row for it arrives.
@MainActor
final class TranscriptViewModelTests: XCTestCase {

    private typealias T = TranscriptTestSupport

    /// The page request the view model queued for `tabId` (the tests run with
    /// no transport, so every send waits in the essential queue).
    private func queuedRequest(_ vm: SessionViewModel, _ tabId: String) -> (before: String?, pageSize: Int?, held: TranscriptRevision?)? {
        for entry in vm.pendingEssentialQueue {
            if case .loadConversation(let id, let before, let pageSize, let held) = entry.command, id == tabId {
                return (before, pageSize, held)
            }
        }
        return nil
    }

    private func opened(_ tabId: String, rows: [Message], status: TabStatus = .idle) -> SessionViewModel {
        let vm = SessionViewModel()
        vm.tabs = [T.tab(tabId, status: status)]
        vm.loadConversationIfNeeded(tabId: tabId)
        vm.handleTranscriptPage(T.page(tabId: tabId, rows: rows))
        return vm
    }

    // MARK: - Opening

    func testOpeningAsksForTheNewestPageAndShowsItsRows() throws {
        let vm = SessionViewModel()
        vm.tabs = [T.tab("t")]
        vm.loadConversationIfNeeded(tabId: "t")

        let request = try XCTUnwrap(queuedRequest(vm, "t"))
        XCTAssertNil(request.before, "the first request is for the newest page")
        XCTAssertTrue(vm.loadingConversation.contains("t"))

        vm.handleTranscriptPage(T.page(tabId: "t", rows: [T.row("u1", .user, "hi"), T.row("a1", .assistant, "hello")]))
        XCTAssertEqual(vm.conversationMessages("t").map(\.id), ["u1", "a1"])
        XCTAssertFalse(vm.loadingConversation.contains("t"))
        XCTAssertFalse(vm.transcriptResyncing.contains("t"))
    }

    func testOpeningAgainDoesNotRefetchWhatIsHeld() {
        let vm = opened("t", rows: [T.row("u1", .user)])
        vm.pendingEssentialQueue.removeAll()
        vm.loadConversationIfNeeded(tabId: "t")
        XCTAssertNil(queuedRequest(vm, "t"))
    }

    func testAnEmptyConversationCountsAsHeld() {
        let vm = opened("t", rows: [])
        vm.pendingEssentialQueue.removeAll()
        vm.loadConversationIfNeeded(tabId: "t")
        XCTAssertNil(queuedRequest(vm, "t"), "a conversation with no rows is still held; it must not re-ask on every appear")
    }

    // MARK: - Unanswered requests

    /// After a reconnect every held transcript is asked for at once, and over
    /// a relay the answers come one after another. A page arriving for one
    /// conversation shows the others are queued, not lost, so their clocks
    /// restart instead of re-asking the whole backlog at five seconds.
    func testAnAnswerRestartsTheClockOfEveryRequestStillWaiting() throws {
        let vm = SessionViewModel()
        vm.tabs = [T.tab("a"), T.tab("b")]
        vm.loadConversationIfNeeded(tabId: "a")
        vm.loadConversationIfNeeded(tabId: "b")
        let waitingClock = try XCTUnwrap(vm.conversationLoadTimers["b"])

        vm.handleTranscriptPage(T.page(tabId: "a", rows: [T.row("u1", .user)]))

        let restarted = try XCTUnwrap(vm.conversationLoadTimers["b"], "the waiting request keeps a clock")
        XCTAssertNotEqual(restarted, waitingClock, "an answer on the connection restarts the waiting clock")
        XCTAssertTrue(waitingClock.isCancelled)
        XCTAssertNil(vm.conversationLoadRetryCount["b"], "restarting is not a retry")
        XCTAssertNil(vm.conversationLoadTimers["a"], "the answered request's clock is gone")
        vm.cancelLoadTimer(tabId: "b")
    }

    // MARK: - Gaps

    /// The reported defect: a sentence that never reached the phone. A missed
    /// patch is now provable (the next patch does not continue from the
    /// revision held), and the phone re-fetches rather than showing the hole.
    func testAMissedPatchReFetchesTheNewestPage() throws {
        let vm = opened("t", rows: [T.row("u1", .user), T.row("a1", .assistant, "Checking ")])
        vm.pendingEssentialQueue.removeAll()

        // rev 0 -> 1 was lost in transit; rev 1 -> 2 arrives.
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 1, total: 2, change: .append(index: 1, id: "a1", field: .content, text: "first.")))

        XCTAssertNotNil(queuedRequest(vm, "t"), "a gap must re-fetch the newest page")
        XCTAssertTrue(vm.transcriptResyncing.contains("t"))
        XCTAssertEqual(vm.conversationMessages("t")[1].content, "Checking ", "a patch that does not fit changes nothing")

        // The fresh page is the server's whole truth, including what was missed.
        vm.handleTranscriptPage(T.page(tabId: "t", rows: [T.row("u1", .user), T.row("a1", .assistant, "Checking ground truth on this machine before answering.")], rev: 2))
        XCTAssertEqual(vm.conversationMessages("t")[1].content, "Checking ground truth on this machine before answering.")
        XCTAssertFalse(vm.transcriptResyncing.contains("t"))
    }

    func testPatchesArrivingBeforeTheFreshPageAreIgnored() {
        let vm = opened("t", rows: [T.row("u1", .user)])
        vm.requestTranscript(tabId: "t", reason: "test", force: true)
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [T.row("a1")])))
        XCTAssertEqual(vm.conversationMessages("t").map(\.id), ["u1"], "the page being fetched supersedes earlier patches")
    }

    func testADispatchStreamPatchNeverTouchesTheTabsTranscript() {
        let vm = opened("t", rows: [T.row("u1", .user)])
        var patch = T.patch(tabId: "t", baseRev: 7, total: 1, change: .splice(at: 0, deleteCount: 1, rows: []))
        patch.streamId = "dispatch:conv-1"
        patch.conversationId = "conv-1"
        vm.handleEvent(.transcriptPatch(patch))
        XCTAssertEqual(vm.conversationMessages("t").map(\.id), ["u1"])
        XCTAssertFalse(vm.transcriptResyncing.contains("t"))
    }

    // MARK: - Reconnect

    /// The server subscribed the stream on the connection that ended. After a
    /// reconnect nothing would ever arrive for it, so every stream held is
    /// asked for again, naming the revision held so an unchanged one is not
    /// sent a second time.
    func testAReconnectAsksAgainForEveryTranscriptHeldNamingItsRevision() throws {
        let vm = opened("t", rows: [T.row("u1", .user)])
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [T.row("a1")])))
        vm.pendingEssentialQueue.removeAll()
        vm.connectionState = .reconnecting

        vm.handleSnapshot(snapshotTabs: [T.tab("t")], recentDirs: [])

        XCTAssertTrue(vm.transcriptResyncing.contains("t"))
        XCTAssertEqual(vm.pendingEssentialQueue.filter { $0.key == "loadConversation:t" }.count, 1,
            "one page request per conversation, not one per path that noticed the reconnect")
        XCTAssertEqual(try XCTUnwrap(queuedRequest(vm, "t")).held, TranscriptRevision(epoch: T.epoch, rev: 1))
    }

    func testAnUnchangedAnswerKeepsTheRowsAndLetsPatchesContinue() {
        let vm = opened("t", rows: [T.row("u1", .user)])
        vm.resyncAllTranscripts(reason: "reconnect")

        var unchanged = T.page(tabId: "t", rows: [], total: 1)
        unchanged.unchanged = true
        vm.handleTranscriptPage(unchanged)

        XCTAssertEqual(vm.conversationMessages("t").map(\.id), ["u1"])
        XCTAssertFalse(vm.transcriptResyncing.contains("t"))
        XCTAssertFalse(vm.loadingConversation.contains("t"))

        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [T.row("a1")])))
        XCTAssertEqual(vm.conversationMessages("t").map(\.id), ["u1", "a1"])
    }

    func testAnUnchangedAnswerForRowsThePhoneLostFetchesThemInFull() throws {
        let vm = opened("t", rows: [T.row("u1", .user)])
        vm.resyncAllTranscripts(reason: "reconnect")
        vm.conversationInstances["t"]?[0].messages = []
        vm.pendingEssentialQueue.removeAll()

        var unchanged = T.page(tabId: "t", rows: [], total: 1)
        unchanged.unchanged = true
        vm.handleTranscriptPage(unchanged)

        let request = try XCTUnwrap(queuedRequest(vm, "t"))
        XCTAssertNil(request.held, "rows that are gone cannot be resumed")
    }

    func testAGapNeverNamesARevision() throws {
        let vm = opened("t", rows: [T.row("u1", .user)])
        vm.pendingEssentialQueue.removeAll()
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 5, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [T.row("a1")])))
        XCTAssertNil(try XCTUnwrap(queuedRequest(vm, "t")).held)
    }

    func testAReplacedInstanceReFetches() {
        let vm = opened("t", rows: [T.row("u1", .user)])
        vm.conversationInstances["t"] = [ConversationInstanceInfo(id: "other", label: "")]
        vm.verifyTranscriptWindow(tabId: "t")
        XCTAssertTrue(vm.transcriptResyncing.contains("t"))
    }

    // MARK: - Older pages

    func testScrollingUpAsksForThePageBeforeTheFirstRowHeld() throws {
        let vm = SessionViewModel()
        vm.tabs = [T.tab("t")]
        vm.handleTranscriptPage(T.page(tabId: "t", rows: [T.row("r5", .user)], startIndex: 5, total: 6))
        vm.pendingEssentialQueue.removeAll()

        vm.loadMoreMessages(tabId: "t")
        XCTAssertEqual(try XCTUnwrap(queuedRequest(vm, "t")).before, "r5")

        vm.handleTranscriptPage(T.page(tabId: "t", rows: (0..<5).map { T.row("r\($0)", $0 == 0 ? .user : .assistant) }, startIndex: 0, total: 6, isNewest: false))
        XCTAssertEqual(vm.conversationMessages("t").map(\.id), ["r0", "r1", "r2", "r3", "r4", "r5"])
        XCTAssertFalse(vm.transcriptStreams["t"]?.hasOlder ?? true)
    }

    // MARK: - The phone's own prompt

    func testASentPromptShowsUntilTheServersRowReplacesIt() throws {
        let vm = opened("t", rows: [T.row("u0", .user, "earlier")])
        vm.submit(tabId: "t", text: "Is it transferred?")

        let pending = try XCTUnwrap(vm.renderedMessages(tabId: "t").last)
        XCTAssertEqual(pending.content, "Is it transferred?")
        guard case .queued? = pending.deliveryState else { return XCTFail("a sent prompt shows as sending") }

        var row = T.row("entry-1", .user, "Is it transferred?")
        row.clientMsgId = pending.id
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [row])))

        XCTAssertEqual(vm.renderedMessages(tabId: "t").map(\.id), ["u0", "entry-1"], "exactly one bubble: the server's")
        XCTAssertNil(vm.pendingPrompts["t"])
    }

    func testAnAcceptedPromptWithNoRowLeaves() throws {
        let vm = opened("t", rows: [])
        vm.submit(tabId: "t", text: "/compact")
        let id = try XCTUnwrap(vm.renderedMessages(tabId: "t").last?.id)
        vm.handleEvent(.promptResult(tabId: "t", clientMsgId: id, status: "accepted", error: nil))
        XCTAssertTrue(vm.renderedMessages(tabId: "t").isEmpty)
        XCTAssertTrue(vm.toastMessages.isEmpty)
    }

    func testARefusedPromptStaysMarkedUntilTheNextSend() throws {
        let vm = opened("t", rows: [], status: .connecting)
        vm.submit(tabId: "t", text: "first")
        let id = try XCTUnwrap(vm.renderedMessages(tabId: "t").last?.id)

        vm.handleEvent(.promptResult(tabId: "t", clientMsgId: id, status: "rejected", error: "server unavailable"))
        guard case .rejected(let error)? = vm.renderedMessages(tabId: "t").last?.deliveryState else {
            return XCTFail("a refused prompt must say so")
        }
        XCTAssertEqual(error, "server unavailable")
        XCTAssertEqual(vm.tabs.first?.status, .idle)
        XCTAssertTrue(vm.toastMessages.contains { $0.title == "Message not delivered" })

        vm.submit(tabId: "t", text: "second")
        XCTAssertEqual(vm.renderedMessages(tabId: "t").map(\.content), ["second"])
    }

    // MARK: - Derived state

    func testRunningToolsFollowTheRun() {
        var tool = T.row("tool-1", .tool)
        tool.toolId = "tool-1"
        tool.toolName = "Bash"
        tool.toolStatus = .running
        let vm = opened("t", rows: [T.row("u1", .user), tool], status: .running)
        XCTAssertEqual(vm.activeTools["t"]?.keys.sorted(), ["tool-1"])

        vm.handleTabStatus(tabId: "t", status: .idle)
        XCTAssertNil(vm.activeTools["t"], "a stopped run lists no running tools")
    }
}
