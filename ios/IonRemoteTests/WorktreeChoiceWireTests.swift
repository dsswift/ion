import XCTest
@testable import IonRemote

/// The remembered worktree choice on the phone: the create carries the
/// Ephemeral and Remember answers to `tabs.create`, the worktree state carries
/// the project's ephemeral default, and the chooser lists the remembered
/// branch first.
final class WorktreeChoiceWireTests: XCTestCase {

    private func createFields(_ command: RemoteCommand) throws -> [String: JSONValue] {
        guard case .action(let call, _) = StudioTransportCommandMapping().request(for: command) else {
            throw NSError(domain: "WorktreeChoiceWireTests", code: 1)
        }
        XCTAssertEqual(call.action, "tabs.create")
        guard case .object(let fields) = call.args.first else { throw NSError(domain: "WorktreeChoiceWireTests", code: 2) }
        return fields
    }

    func testCreateCarriesTheEphemeralAndRememberAnswers() throws {
        let fields = try createFields(.createTab(
            workingDirectory: "/repo", clientCmdId: "c1", useWorktree: true, sourceBranch: "main",
            ephemeralWorktree: false, rememberWorktreeChoice: true))
        XCTAssertEqual(fields["sourceBranch"], .string("main"))
        XCTAssertEqual(fields["ephemeralWorktree"], .bool(false))
        XCTAssertEqual(fields["rememberWorktreeChoice"], .bool(true))
    }

    /// Unsaid stays unsaid, so the server applies the remembered answer, then
    /// the project's `.ion/worktree.json`.
    func testCreateWithoutAnswersLeavesThemToTheServer() throws {
        let fields = try createFields(.createTab(workingDirectory: "/repo", clientCmdId: "c1", useWorktree: true, sourceBranch: "main"))
        XCTAssertNil(fields["ephemeralWorktree"])
        XCTAssertNil(fields["rememberWorktreeChoice"])
    }

    @MainActor
    func testWorktreeStateCarriesTheEphemeralDefault() throws {
        let viewModel = SessionViewModel()
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[],"defaultSourceBranch":"main","ephemeralDefault":true}]}
        """.data(using: .utf8)!
        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            throw NSError(domain: "WorktreeChoiceWireTests", code: 3)
        }
        viewModel.handleWorktreeState(states)
        XCTAssertEqual(viewModel.worktreeState(for: "/repo")?.ephemeralDefault, true)
    }

    func testChooserListsTheRememberedBranchFirst() {
        XCTAssertEqual(WorktreeBranchChooserSheet.ordered(["dev", "main", "release"], saved: "release"), ["release", "dev", "main"])
        XCTAssertEqual(WorktreeBranchChooserSheet.ordered(["dev", "main"], saved: "gone"), ["dev", "main"])
        XCTAssertEqual(WorktreeBranchChooserSheet.ordered(["dev", "main"], saved: nil), ["dev", "main"])
    }
}
