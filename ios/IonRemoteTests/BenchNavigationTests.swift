import XCTest
@testable import IonRemote

@MainActor
final class BenchNavigationTests: XCTestCase {
    private func states(conversations: [(id: String, role: String?)] = []) throws -> [RemoteWorktreeState] {
        let rendered = conversations.map { conversation in
            let role = conversation.role.map { ",\"tabRole\":\"\($0)\"" } ?? ""
            return "{\"tabId\":\"\(conversation.id)\",\"title\":\"Bench work\",\"status\":\"running\",\"index\":1\(role)}"
        }.joined(separator: ",")
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"main","benchPath":"/bench","benchBranch":"ion/bench/main",
          "baseSha":"abc","lastBuiltAt":1,"baseDrifted":false,"openConversations":[\(rendered)]}]}]}
        """.data(using: .utf8)!
        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            throw NSError(domain: "BenchNavigationTests", code: 1)
        }
        return states
    }

    func testExistingBenchConversationNavigatesWithoutPendingResolution() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try states(conversations: [("talk-1", nil)]))

        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")

        XCTAssertEqual(viewModel.pendingNavigationTabId, "talk-1")
        XCTAssertNil(viewModel.pendingBenchConversation)
    }

    func testMissingBenchConversationResolvesExactlyOnceFromSnapshot() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try states())

        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")
        XCTAssertNotNil(viewModel.pendingBenchConversation)
        XCTAssertNil(viewModel.pendingNavigationTabId)

        let created = try states(conversations: [("talk-2", nil)])
        viewModel.handleWorktreeState(created)
        XCTAssertEqual(viewModel.pendingNavigationTabId, "talk-2")
        XCTAssertNil(viewModel.pendingBenchConversation)

        viewModel.pendingNavigationTabId = nil
        viewModel.handleWorktreeState(created)
        XCTAssertNil(viewModel.pendingNavigationTabId)
    }

    func testBenchActionCyclesAutoFixAndPersistentConversations() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try states(conversations: [
            ("talk-1", "bench-conversation"),
            ("fix-1", "conflict-auto-fix"),
        ]))

        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")
        XCTAssertEqual(viewModel.pendingNavigationTabId, "talk-1")
        viewModel.pendingNavigationTabId = nil
        viewModel.focusedTabId = "talk-1"

        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")
        XCTAssertEqual(viewModel.pendingNavigationTabId, "fix-1")
        viewModel.pendingNavigationTabId = nil
        viewModel.focusedTabId = "fix-1"

        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")
        XCTAssertEqual(viewModel.pendingNavigationTabId, "talk-1")
    }

    func testLoneAutoFixNavigatesWithoutCreatingSingleton() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try states(conversations: [("fix-1", "conflict-auto-fix")]))

        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")

        XCTAssertEqual(viewModel.pendingNavigationTabId, "fix-1")
        XCTAssertNil(viewModel.pendingBenchConversation)
    }

    func testTimeoutTaskClearsPendingRequest() async throws {
        let viewModel = SessionViewModel()
        viewModel.benchConversationNavigationTimeout = .milliseconds(1)
        viewModel.handleWorktreeState(try states())
        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")

        // Await the real timeout task rather than sleeping a fixed interval:
        // simulator scheduling makes wall-clock waits flaky.
        let task = try XCTUnwrap(viewModel.pendingBenchConversation?.timeoutTask)
        await task.value

        XCTAssertNil(viewModel.pendingBenchConversation)
        XCTAssertNil(viewModel.pendingNavigationTabId)
    }

    func testTimeoutClearsMatchingPendingRequest() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try states())
        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")
        let requestId = try XCTUnwrap(viewModel.pendingBenchConversation?.requestId)

        viewModel.timeoutPendingBenchConversation(requestId: requestId)

        XCTAssertNil(viewModel.pendingBenchConversation)
        XCTAssertNil(viewModel.pendingNavigationTabId)
    }

    func testStaleTimeoutDoesNotCancelNewRequest() throws {
        let viewModel = SessionViewModel()
        viewModel.benchConversationNavigationTimeout = .seconds(60)
        viewModel.handleWorktreeState(try states())
        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")
        let staleRequestId = try XCTUnwrap(viewModel.pendingBenchConversation?.requestId)
        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "other")
        let activeRequestId = try XCTUnwrap(viewModel.pendingBenchConversation?.requestId)

        viewModel.timeoutPendingBenchConversation(requestId: staleRequestId)

        XCTAssertEqual(viewModel.pendingBenchConversation?.requestId, activeRequestId)
        viewModel.cancelPendingBenchConversation(reason: "test cleanup")
    }

    func testTransientResetCancelsPendingBenchConversation() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try states())
        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")

        viewModel.wipeTransientState()

        XCTAssertNil(viewModel.pendingBenchConversation)
    }

    func testUnknownCompletionReasonReachesInstanceStatus() throws {
        let viewModel = SessionViewModel()
        let statusJSON = #"{"label":"main","state":"idle","model":"model","contextPercent":0,"contextWindow":1}"#
            .data(using: .utf8)!
        var instance = ConversationInstanceInfo(id: "main", label: "Main")
        instance.statusFields = try JSONDecoder().decode(StatusFields.self, from: statusJSON)
        viewModel.conversationInstances["tab"] = [instance]
        let eventJSON = #"{"type":"desktop_task_complete","tabId":"tab","result":"done","costUsd":0,"reason":"future_reason"}"#
            .data(using: .utf8)!

        viewModel.handleEvent(try JSONDecoder().decode(RemoteEvent.self, from: eventJSON))

        XCTAssertEqual(viewModel.conversationInstances["tab"]?.first?.statusFields?.completionReason,
                       .unknown("future_reason"))
    }

    func testDisconnectCancelsPendingBenchConversation() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try states())
        viewModel.openBenchConversation(repoPath: "/repo", sourceBranch: "main")

        viewModel.disconnect()

        XCTAssertNil(viewModel.pendingBenchConversation)
    }
}
