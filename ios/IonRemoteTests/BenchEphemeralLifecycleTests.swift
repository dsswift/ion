import XCTest
@testable import IonRemote

/// Ephemeral conversations cannot be perpetuated.
///
/// A bench is rebuildable scratch space: the next assembly recreates its branch
/// from each member's pinned commit and deletes everything in it. A machine
/// conversation (auto-fix, verification analysis) is input-locked and was never
/// typeable. So neither can be parked for later (snooze) nor brought back after
/// settling (un-settle).
///
/// Each verb is absent from the row AND refused by the command path. These pin
/// the command path, which is what a stale row would still reach.
@MainActor
final class BenchEphemeralLifecycleTests: XCTestCase {

    private func benchState() throws -> [RemoteWorktreeState] {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"main","benchPath":"/bench","benchBranch":"ion/bench/main",
          "baseSha":"abc","lastBuiltAt":1,"baseDrifted":false}]}]}
        """.data(using: .utf8)!
        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            throw NSError(domain: "BenchEphemeralLifecycleTests", code: 1)
        }
        return states
    }

    private func tab(
        id: String,
        directory: String,
        role: String? = nil,
        settled: Bool = false,
        canRestore: Bool? = nil
    ) throws -> RemoteTabState {
        let roleField = role.map { ",\"tabRole\":\"\($0)\"" } ?? ""
        let restoreField = canRestore.map { ",\"canRestoreSettled\":\($0)" } ?? ""
        let json = """
        {"id":"\(id)","title":"Work","status":"idle","workingDirectory":"\(directory)",
         "permissionMode":"auto","permissionQueue":[],
         "inboxState":"\(settled ? "settled" : "active")"\(roleField)\(restoreField)}
        """.data(using: .utf8)!
        return try JSONDecoder().decode(RemoteTabState.self, from: json)
    }

    func testBenchConversationIsIdentifiedByContainment() throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try benchState())

        XCTAssertTrue(viewModel.isBenchConversation(try tab(id: "a", directory: "/bench")))
        // Nested counts: a subdirectory of the bench is still the bench.
        XCTAssertTrue(viewModel.isBenchConversation(try tab(id: "b", directory: "/bench/desktop")))
        // A sibling that merely shares the prefix is a different directory.
        XCTAssertFalse(viewModel.isBenchConversation(try tab(id: "c", directory: "/bench-other")))
        XCTAssertFalse(viewModel.isBenchConversation(try tab(id: "d", directory: "/repo")))
        XCTAssertFalse(viewModel.isBenchConversation(try tab(id: "e", directory: "")))
    }

    func testSnoozeCommandIsRefusedForABenchConversationAndSentOtherwise() async throws {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeState(try benchState())
        viewModel.tabs = [try tab(id: "bench-talk", directory: "/bench"),
                          try tab(id: "repo-talk", directory: "/repo")]
        let wake = Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1000

        // Snooze is user-initiated and deliberately NOT queueable, so with no
        // transport `send` drops it and raises a "Not connected" toast. That
        // toast is therefore the proof the command path was entered at all: a
        // refusal returns before `send` and raises nothing.
        // `send` raises its toast from a Task, so both assertions yield first.
        // Without the yield the accepted case reads as zero toasts too, which
        // would make this test pass no matter what the gate did.
        viewModel.snoozeTab(tabId: "bench-talk", untilMs: wake)
        await Task.yield()
        XCTAssertTrue(viewModel.toastMessages.isEmpty,
                      "a bench conversation must never reach the snooze command")

        viewModel.snoozeTab(tabId: "repo-talk", untilMs: wake)
        await Task.yield()
        XCTAssertEqual(viewModel.toastMessages.count, 1,
                       "an ordinary conversation still reaches the command path")
    }

    // MARK: - Permanent settlement

    /// The roles that settle for good. A bench conversation's checkout is
    /// rebuilt from its members' pins; a machine conversation was never
    /// typeable. Neither can be returned to active work.
    func testEphemeralRolesSettlePermanently() throws {
        let viewModel = SessionViewModel()
        for role in ["bench-conversation", "conflict-auto-fix", "verification-analysis"] {
            XCTAssertTrue(viewModel.settlingIsPermanent(try tab(id: role, directory: "/repo", role: role)),
                          "\(role) must settle permanently")
        }
        XCTAssertFalse(viewModel.settlingIsPermanent(try tab(id: "plain", directory: "/repo")))
    }

    /// The desktop states permanence in canRestoreSettled; the command path
    /// honours it, which is what a stale row would still reach.
    func testUnsettleIsRefusedForAPermanentlySettledRecord() async throws {
        let viewModel = SessionViewModel()
        viewModel.tabs = [
            try tab(id: "bench", directory: "/bench", role: "bench-conversation", settled: true, canRestore: false),
            try tab(id: "plain", directory: "/repo", settled: true, canRestore: true)
        ]

        viewModel.unsettleTab(tabId: "bench")
        await Task.yield()
        XCTAssertTrue(viewModel.toastMessages.isEmpty,
                      "a permanently settled record must never reach the un-settle command")

        viewModel.unsettleTab(tabId: "plain")
        await Task.yield()
        XCTAssertEqual(viewModel.toastMessages.count, 1,
                       "an ordinary settled record still reaches the command path")
    }

    /// A cold settled record lives in settledTabs, not tabs, and must be
    /// refused there too — that is the list the settled shelf renders from.
    func testUnsettleIsRefusedForAColdSettledRecord() async throws {
        let viewModel = SessionViewModel()
        viewModel.settledTabs = [
            try tab(id: "cold", directory: "/bench", role: "conflict-auto-fix", settled: true, canRestore: false)
        ]

        viewModel.unsettleTab(tabId: "cold")
        await Task.yield()
        XCTAssertTrue(viewModel.toastMessages.isEmpty)
    }

    /// The settle verb names its consequence before the tap, since Un-settle is
    /// absent afterwards.
    func testSettleVerbNamesPermanenceOnBothSurfaces() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/TabListView+Inbox.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(source.contains("viewModel.settlingIsPermanent(tab) ? \"Settle for good\""),
                      "the swipe action must name a permanent settlement")
        XCTAssertTrue(source.contains("viewModel.settlingIsPermanent(tab) ? \"Settle permanently\""),
                      "the context menu must name a permanent settlement")
    }
}
