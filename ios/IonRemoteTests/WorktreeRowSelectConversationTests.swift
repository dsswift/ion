import XCTest
@testable import IonRemote

/// WorktreeRowView "Open here" conversation rows are tappable — each calls
/// `onSelectConversation(tabId)`, wired by `WorktreeListView` to
/// `viewModel.navigateToTab(_:)`.
///
/// SwiftUI view interactions aren't directly tap-tested in this codebase (no
/// ViewInspector), so — following `BenchNavigationTests.swift`'s pattern for
/// the equivalent bench-conversation navigation path — this pins the
/// ViewModel-level seam the row's Button ultimately calls: decode a worktree
/// state carrying `openConversations`, then invoke `navigateToTab` with one of
/// those conversations' `tabId` exactly as `WorktreeListView`'s
/// `onSelectConversation` closure does, and assert the pending-navigation
/// contract fires.
///
/// Regression direction: this is new coverage for a new parity gap closed on
/// iOS (the desktop's row menu could already focus any listed conversation;
/// iOS's "Open here" rows were previously inert `Text`). There is no prior
/// passing-both-ways behavior to diff against — the pin is that the wiring
/// exists and reaches `pendingNavigationTabId` at all.
@MainActor
final class WorktreeRowSelectConversationTests: XCTestCase {
    private func states(openConversations: [(tabId: String, title: String)]) throws -> [RemoteWorktreeState] {
        let conversations = openConversations.enumerated().map { i, c in
            #"{"tabId":"\#(c.tabId)","title":"\#(c.title)","status":"idle","index":\#(i + 1)}"#
        }.joined(separator: ",")
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[{
          "worktreePath":"/wt","branchName":"wt/a3f1","label":"ion-a3f1",
          "head":"abc1234","lastCommitSubject":"fix token expiry",
          "isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true,
          "openConversations":[\(conversations)]}],"benches":[]}]}
        """.data(using: .utf8)!
        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            throw NSError(domain: "WorktreeRowSelectConversationTests", code: 1)
        }
        return states
    }

    func testOpenConversationCountLabelUsesParenthesizedCountAndHidesZero() throws {
        let noOpen = try XCTUnwrap(states(openConversations: []).first?.worktrees.first)
        XCTAssertNil(noOpen.openConversationCountLabel)

        let oneOpen = try XCTUnwrap(states(openConversations: [
            (tabId: "talk-1", title: "Fix the parser"),
        ]).first?.worktrees.first)
        XCTAssertEqual(oneOpen.openConversationCountLabel, "(1)")

        let twoOpen = try XCTUnwrap(states(openConversations: [
            (tabId: "talk-1", title: "Fix the parser"),
            (tabId: "talk-2", title: "Add tests"),
        ]).first?.worktrees.first)
        XCTAssertEqual(twoOpen.openConversationCountLabel, "(2)")
    }

    func testSelectingAnOpenConversationNavigatesToItsTabId() throws {
        let viewModel = SessionViewModel()
        let states = try states(openConversations: [
            (tabId: "talk-1", title: "Fix the parser"),
            (tabId: "talk-2", title: "Add tests"),
        ])
        viewModel.handleWorktreeState(states)

        let worktree = try XCTUnwrap(viewModel.worktreeState(for: "/repo")?.worktrees.first)
        XCTAssertEqual(worktree.openConversations.count, 2)

        // Exactly what WorktreeRowView's Button does for the second row:
        // onSelectConversation(conversation.tabId) -> viewModel.navigateToTab.
        let second = worktree.openConversations[1]
        viewModel.navigateToTab(second.tabId)

        XCTAssertEqual(viewModel.pendingNavigationTabId, "talk-2")
    }

    func testEachConversationInTheListNavigatesToItsOwnTabIdNotTheFirst() throws {
        // The regression this closes: before, "Open here" rows were inert
        // Text, so there was no way to reach a conversation other than the
        // one the row's own click-cycle happened to land on next. Pin that
        // every row is independently addressable, not just the first.
        let viewModel = SessionViewModel()
        let states = try states(openConversations: [
            (tabId: "talk-1", title: "Fix the parser"),
            (tabId: "talk-2", title: "Add tests"),
            (tabId: "talk-3", title: "Resolve conflict"),
        ])
        viewModel.handleWorktreeState(states)
        let worktree = try XCTUnwrap(viewModel.worktreeState(for: "/repo")?.worktrees.first)

        viewModel.navigateToTab(worktree.openConversations[2].tabId)
        XCTAssertEqual(viewModel.pendingNavigationTabId, "talk-3")

        viewModel.pendingNavigationTabId = nil
        viewModel.navigateToTab(worktree.openConversations[0].tabId)
        XCTAssertEqual(viewModel.pendingNavigationTabId, "talk-1")
    }
}
