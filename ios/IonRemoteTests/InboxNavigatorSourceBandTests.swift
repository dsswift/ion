import XCTest
@testable import IonRemote

/// When the checkout's own conversations earn the Source Repository band.
final class InboxNavigatorSourceBandTests: XCTestCase {
    private let decoder = JSONDecoder()

    /// A project with a state record but NO worktrees and NO bench is a plain
    /// project. Its conversations must file flat (directTabs), not into the
    /// Source Repository band. Every project with a live conversation gets a
    /// state record, so keying the band on "a record exists" filed every plain
    /// project's conversations under a band the view never rendered — the
    /// chevron toggled and nothing appeared.
    func testPlainProjectWithAStateRecordFilesConversationsFlat() throws {
        let empty = try emptyWorktreeState(repoPath: "/plain")
        let tab = try tab(id: "conversation", directory: "/plain", state: "active", settledAt: nil)

        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [empty.repoPath: empty]).first)

        XCTAssertEqual(project.directTabs.map(\.id), ["conversation"])
        XCTAssertTrue(project.sourceTabs.isEmpty)
        XCTAssertEqual(project.conversationCount, 1)
    }

    /// The same project with worktree inventory DOES have a Source Repository
    /// band, so a conversation in the source checkout files there.
    func testManagedProjectFilesSourceCheckoutConversationsInTheSourceBand() throws {
        let state = try worktreeState()
        let tab = try tab(id: "conversation", directory: "/repo", state: "active", settledAt: nil)

        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [state.repoPath: state]).first)

        XCTAssertEqual(project.sourceTabs.map(\.id), ["conversation"])
        XCTAssertTrue(project.directTabs.isEmpty)
    }

    /// A landed worktree draws no band of its own, so it gives the Source
    /// Repository band nothing to stand apart from. A project whose only
    /// inventory is landed files its conversations flat.
    func testProjectWithOnlyLandedWorktreesFilesConversationsFlat() throws {
        let state = try landedWorktreeState()
        let tab = try tab(id: "conversation", directory: "/repo", state: "active", settledAt: nil)

        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [tab], states: [state.repoPath: state]).first)

        XCTAssertEqual(project.directTabs.map(\.id), ["conversation"])
        XCTAssertTrue(project.sourceTabs.isEmpty)
        XCTAssertTrue(InboxNavigator.orderedWorktrees(for: project).isEmpty)
    }

    /// A landed worktree that still holds a conversation does draw its band,
    /// so the source checkout's conversations go back under Source Repository.
    func testLandedWorktreeWithAConversationKeepsTheSourceBand() throws {
        let state = try landedWorktreeState()
        let source = try tab(id: "source", directory: "/repo", state: "active", settledAt: nil)
        let landed = try tab(id: "landed", directory: "/repo/.ion/worktrees/a", state: "active", settledAt: nil)

        let project = try XCTUnwrap(InboxNavigator.projects(tabs: [source, landed], states: [state.repoPath: state]).first)

        XCTAssertEqual(project.sourceTabs.map(\.id), ["source"])
        XCTAssertTrue(project.directTabs.isEmpty)
        XCTAssertEqual(project.worktreeOrder, ["/repo/.ion/worktrees/a"])
    }

    private func tab(id: String, directory: String, state: String, settledAt: Double?) throws -> RemoteTabState {
        let settled = settledAt.map { ", \"settledAt\": \($0)" } ?? ""
        let json = """
        {"id":"\(id)","title":"Test","status":"idle","workingDirectory":"\(directory)",
        "permissionMode":"auto","permissionQueue":[],"inboxState":"\(state)"\(settled)}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteTabState.self, from: json)
    }

    private func worktreeState() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/repo","worktrees":[{"worktreePath":"/repo/.ion/worktrees/a",
        "branchName":"wt/a","label":"a","head":"abc","lastCommitSubject":"",
        "isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true}],"benches":[]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }

    /// A project whose one inventory worktree has landed and not been retired.
    private func landedWorktreeState() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/repo","worktrees":[{"worktreePath":"/repo/.ion/worktrees/a",
        "branchName":"wt/a","label":"a","head":"abc","lastCommitSubject":"",
        "isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true,
        "landedAt":1}],"benches":[]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }

    /// A project the desktop has crawled and found no worktrees or benches in.
    /// Every project with a live conversation receives one of these.
    private func emptyWorktreeState(repoPath: String) throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"\(repoPath)","worktrees":[],"benches":[]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }
}
