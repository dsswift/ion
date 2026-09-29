import XCTest
@testable import IonRemote

/// Worktree and bench state belongs to one server. Kept across a switch to
/// another pairing, the previous server's repository stayed in the Inbox as a
/// project of its own: no conversations, but that server's bench and
/// worktrees, beside the new server's project of the same name.
@MainActor
final class WorktreePairingResetTests: XCTestCase {

    private func previousServersState() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/previous/ion","worktrees":[{"worktreePath":"/previous/ion/.ion/worktrees/a",
        "branchName":"wt/a","label":"a","head":"abc","lastCommitSubject":"",
        "isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true}],"benches":[]}
        """.data(using: .utf8)!
        return try JSONDecoder().decode(RemoteWorktreeState.self, from: json)
    }

    func testAPairingChangeLeavesNoProjectOfThePreviousServerInTheInbox() throws {
        let vm = SessionViewModel()
        let state = try previousServersState()
        vm.handleWorktreeState([state])
        vm.worktreeBusyPath = "/previous/ion/.ion/worktrees/a"
        vm.benchBusy = true
        vm.handleWorktreePipeline(RemoteWorktreePipeline(
            repoPath: "/previous/ion", sourceBranch: "main", phase: .resolving,
            queue: [], current: nil, needsManual: [], resolvedByAi: 0, summary: nil))
        vm.recentDirectories = ["/previous/ion"]
        XCTAssertFalse(InboxNavigator.projects(tabs: [], states: vm.worktreeStates).isEmpty,
                       "precondition: the previous server's worktree shows as a project")

        vm.wipeTransientState()

        XCTAssertTrue(vm.worktreeStates.isEmpty)
        XCTAssertTrue(InboxNavigator.projects(tabs: vm.tabs, states: vm.worktreeStates).isEmpty,
                      "no project of the previous server survives a pairing change")
        XCTAssertTrue(vm.settledTabs.isEmpty)
        XCTAssertNil(vm.worktreeBusyPath)
        XCTAssertFalse(vm.benchBusy)
        XCTAssertTrue(vm.worktreePipelines.isEmpty)
        XCTAssertTrue(vm.recentDirectories.isEmpty)
    }
}
