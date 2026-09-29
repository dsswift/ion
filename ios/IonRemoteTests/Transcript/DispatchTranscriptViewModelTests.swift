import XCTest
@testable import IonRemote

/// A dispatched agent's transcript is a server stream like a tab's: opened by
/// a page request naming the dispatch, kept current by patches, fetched anew
/// on any gap, and held whole so every previous dispatch can be reviewed.
@MainActor
final class DispatchTranscriptViewModelTests: XCTestCase {

    private typealias T = TranscriptTestSupport

    private func dispatch(_ id: String, conversationId: String, status: String = "running") -> DispatchInfo {
        DispatchInfo(from: ["id": id, "task": "t", "model": "m", "conversationId": conversationId, "status": status])
    }

    private func agent(_ name: String, dispatches: [(id: String, conversationId: String)]) throws -> AgentStateUpdate {
        let raw: [String: Any] = [
            "id": name, "name": name, "status": "running",
            "metadata": [
                "displayName": name, "type": "specialist", "visibility": "always", "invited": false,
                "dispatches": dispatches.map { ["id": $0.id, "task": "t", "model": "m", "conversationId": $0.conversationId, "status": "running"] },
            ] as [String: Any],
        ]
        return try JSONDecoder().decode(AgentStateUpdate.self, from: JSONSerialization.data(withJSONObject: raw))
    }

    private func queued(_ vm: SessionViewModel) -> [(conversationId: String, dispatchId: String, before: String?)] {
        vm.pendingEssentialQueue.compactMap { entry in
            if case .loadDispatchTranscript(_, let conversationId, let dispatchId, let before, _) = entry.command {
                return (conversationId, dispatchId, before)
            }
            return nil
        }
    }

    private func page(_ conversationId: String, _ dispatchId: String, rows: [Message], rev: Int = 0, startIndex: Int = 0, total: Int? = nil, isNewest: Bool = true) -> TranscriptPage {
        var page = T.page(tabId: "tab-1", rows: rows, rev: rev, startIndex: startIndex, total: total, isNewest: isNewest)
        page.conversationId = conversationId
        page.dispatchId = dispatchId
        page.streamId = "dispatch:\(conversationId):\(dispatchId)"
        return page
    }

    private func patch(_ conversationId: String, _ dispatchId: String, baseRev: Int, total: Int, change: TranscriptChange) -> TranscriptPatch {
        TranscriptPatch(
            streamId: "dispatch:\(conversationId):\(dispatchId)", tabId: "tab-1", instanceId: nil,
            conversationId: conversationId, dispatchId: dispatchId,
            epoch: T.epoch, baseRev: baseRev, rev: baseRev + 1, total: total, change: change
        )
    }

    private func key(_ conversationId: String, _ dispatchId: String) -> String {
        SessionViewModel.dispatchKey(conversationId: conversationId, dispatchId: dispatchId)
    }

    func testOpeningADispatchAsksForItsNewestPageAndHoldsItsRows() {
        let vm = SessionViewModel()
        vm.loadAgentDispatchConversation(tabId: "tab-1", dispatch: dispatch("d1", conversationId: "c1"))
        XCTAssertEqual(queued(vm).map(\.conversationId), ["c1"])
        XCTAssertEqual(queued(vm).first?.dispatchId, "d1")
        XCTAssertNil(queued(vm).first?.before)
        XCTAssertTrue(vm.agentConversationLoading.contains(key("c1", "d1")))

        vm.handleEvent(.transcriptPage(page("c1", "d1", rows: [T.row("user-1", .user, "go"), T.row("assistant-2", .assistant, "done")])))
        XCTAssertEqual(vm.agentConversationMessages[key("c1", "d1")]?.map(\.id), ["user-1", "assistant-2"])
        XCTAssertFalse(vm.agentConversationLoading.contains(key("c1", "d1")))
        XCTAssertTrue(vm.conversationMessages("tab-1").isEmpty, "a dispatch's rows never land in its tab's transcript")
    }

    func testTwoDispatchesOfOneConversationAreHeldApart() {
        let vm = SessionViewModel()
        vm.handleEvent(.transcriptPage(page("c1", "d1", rows: [T.row("a", .user)])))
        vm.handleEvent(.transcriptPage(page("c1", "d2", rows: [T.row("a", .user), T.row("b")])))
        XCTAssertEqual(vm.agentConversationMessages[key("c1", "d1")]?.count, 1)
        XCTAssertEqual(vm.agentConversationMessages[key("c1", "d2")]?.count, 2)
    }

    func testPatchesKeepADispatchCurrentAndAGapFetchesItAnew() {
        let vm = SessionViewModel()
        vm.loadAgentDispatchConversation(tabId: "tab-1", dispatch: dispatch("d1", conversationId: "c1"))
        vm.handleEvent(.transcriptPage(page("c1", "d1", rows: [T.row("u", .user), T.row("a", .assistant, "Work")])))
        vm.handleEvent(.transcriptPatch(patch("c1", "d1", baseRev: 0, total: 2, change: .append(index: 1, id: "a", field: .content, text: "ing"))))
        XCTAssertEqual(vm.agentConversationMessages[key("c1", "d1")]?.last?.content, "Working")

        vm.pendingEssentialQueue.removeAll()
        vm.handleEvent(.transcriptPatch(patch("c1", "d1", baseRev: 5, total: 2, change: .append(index: 1, id: "a", field: .content, text: "!"))))
        XCTAssertEqual(queued(vm).map(\.conversationId), ["c1"], "a gap in a dispatch stream fetches its newest page again")
        XCTAssertEqual(vm.agentConversationMessages[key("c1", "d1")]?.last?.content, "Working")
    }

    /// Reviewing a long previous dispatch shows all of it: a page that leaves
    /// older rows behind is followed at once by a request for the page
    /// before it.
    func testALongDispatchIsFetchedWhole() {
        let vm = SessionViewModel()
        vm.loadAgentDispatchConversation(tabId: "tab-1", dispatch: dispatch("d1", conversationId: "c1", status: "done"))
        vm.pendingEssentialQueue.removeAll()
        vm.handleEvent(.transcriptPage(page("c1", "d1", rows: [T.row("r2", .user), T.row("r3")], startIndex: 2, total: 4)))
        XCTAssertEqual(queued(vm).first?.before, "r2")

        vm.pendingEssentialQueue.removeAll()
        vm.handleEvent(.transcriptPage(page("c1", "d1", rows: [T.row("r0", .user), T.row("r1")], startIndex: 0, total: 4, isNewest: false)))
        XCTAssertEqual(vm.agentConversationMessages[key("c1", "d1")]?.map(\.id), ["r0", "r1", "r2", "r3"])
        XCTAssertTrue(queued(vm).isEmpty, "nothing older remains to ask for")
    }

    func testAReconnectReFetchesEveryDispatchHeld() {
        let vm = SessionViewModel()
        vm.loadAgentDispatchConversation(tabId: "tab-1", dispatch: dispatch("d1", conversationId: "c1"))
        vm.handleEvent(.transcriptPage(page("c1", "d1", rows: [T.row("u", .user)])))
        vm.pendingEssentialQueue.removeAll()
        vm.connectionState = .reconnecting
        vm.handleSnapshot(snapshotTabs: [], recentDirs: [])
        XCTAssertEqual(queued(vm).map(\.conversationId), ["c1"])
        XCTAssertTrue(vm.dispatchResyncing.contains(key("c1", "d1")))
    }

    func testPreloadingOpensTheAgentsOtherDispatches() throws {
        let vm = SessionViewModel()
        let worker = try agent("worker", dispatches: [(id: "d1", conversationId: "c1"), (id: "d2", conversationId: "c2")])
        vm.preloadAgentDispatches(tabId: "tab-1", agent: worker, excluding: "c1")
        XCTAssertEqual(queued(vm).map(\.conversationId), ["c2"])
    }

    func testClosingATabForgetsTheDispatchesOpenedThroughIt() {
        let vm = SessionViewModel()
        vm.loadAgentDispatchConversation(tabId: "tab-1", dispatch: dispatch("d1", conversationId: "c1"))
        vm.handleEvent(.transcriptPage(page("c1", "d1", rows: [T.row("u", .user)])))
        vm.handleTabClosed(tabId: "tab-1")
        XCTAssertNil(vm.agentConversationMessages[key("c1", "d1")])
        XCTAssertNil(vm.dispatchStreams[key("c1", "d1")])
    }
}
