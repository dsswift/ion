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

    /// Regression: the desktop sends `lastAssembly: "assembled"` (see
    /// `IntegrationWorkspace.lastAssembly` in types-bench.ts), but this view's
    /// status text used to compare against the string "ok" -- which never
    /// matched, so a successfully-assembled bench always fell through to
    /// "Ready" and never showed how long ago it was assembled.
    func testRelativeAssemblyTimeNeverAssembled() {
        XCTAssertEqual(BenchAssemblyTime.relative(0), "never assembled")
    }

    func testRelativeAssemblyTimeJustNow() {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let result = BenchAssemblyTime.relative(nowMs)
        XCTAssertTrue(result.hasPrefix("assembled "), "expected an 'assembled ...' prefix, got \(result)")
    }

    func testRelativeAssemblyTimeMinutesAgo() {
        let fiveMinutesAgoMs = (Date().timeIntervalSince1970 - 5 * 60) * 1000
        let result = BenchAssemblyTime.relative(fiveMinutesAgoMs)
        XCTAssertTrue(result.hasPrefix("assembled "), "expected an 'assembled ...' prefix, got \(result)")
        XCTAssertTrue(result.contains("5"), "expected the 5-minute figure to appear, got \(result)")
    }

    // MARK: - Bench header summary (desktop parity)

    /// The bench header used to show EITHER the stale-member count OR the
    /// assembly age. A bench with a stale member hid how old the build was,
    /// and a bench with no stale members hid how many members it held — so a
    /// bench that had silently lost every member read exactly like a healthy
    /// one. Both facts now ride the same line, matching the desktop's
    /// `benchMemberSummary` in shared/worktree-list.ts.
    func testSummaryReportsMemberCountWithTheAssemblyAge() {
        let twoHoursAgoMs = (Date().timeIntervalSince1970 - 2 * 3600) * 1000
        let result = BenchAssemblyTime.summary(total: 2, behind: 0, lastBuiltAtMs: twoHoursAgoMs)
        XCTAssertTrue(result.hasPrefix("2 members · assembled "), "got \(result)")
    }

    func testSummaryKeepsTheAgeWhenMembersAreOutOfDate() {
        let nineHoursAgoMs = (Date().timeIntervalSince1970 - 9 * 3600) * 1000
        let result = BenchAssemblyTime.summary(total: 3, behind: 2, lastBuiltAtMs: nineHoursAgoMs)
        XCTAssertTrue(result.hasPrefix("3 members · 2 out of date · assembled "), "got \(result)")
    }

    func testSummarySingularisesOneMember() {
        let result = BenchAssemblyTime.summary(total: 1, behind: 1, lastBuiltAtMs: 0)
        XCTAssertEqual(result, "1 member · 1 out of date · never assembled")
    }

    func testSummaryReportsAnEmptyBench() {
        XCTAssertEqual(BenchAssemblyTime.summary(total: 0, behind: 0, lastBuiltAtMs: 0), "no members")
    }

    func testSummaryReportsANeverAssembledBench() {
        XCTAssertEqual(BenchAssemblyTime.summary(total: 2, behind: 0, lastBuiltAtMs: 0),
                       "2 members · never assembled")
    }
}
