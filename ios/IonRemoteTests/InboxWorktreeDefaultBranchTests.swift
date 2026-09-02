import XCTest
@testable import IonRemote

/// Inbox "New worktree conversation" — use the recorded default source branch.
///
/// The desktop resolves `sourceBranch || worktreeBranchDefaults[dir]` and only
/// defers to the branch picker when NO default is recorded. iOS used to ALWAYS
/// open the picker because the per-project default never reached the phone. The
/// fix projects the default onto `RemoteWorktreeState.defaultSourceBranch`, and
/// the inbox action creates the worktree directly when one is set.
///
/// Regression direction: dropping `defaultSourceBranch` from the wire decode
/// turns the state test red; reverting the inbox action to the unconditional
/// `requestGitBranches` call turns the source-gate test red.
final class InboxWorktreeDefaultBranchTests: XCTestCase {

    private var inboxSource: String {
        get throws {
            let url = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("IonRemote/Views/TabListView+Inbox.swift")
            return try String(contentsOf: url, encoding: .utf8)
        }
    }

    /// The projected default reaches iOS through the SAME `desktop_worktree_state`
    /// event the inbox already consumes — no separate lookup, no separate wire.
    @MainActor
    func testWorktreeStateCarriesTheRecordedDefaultSourceBranch() throws {
        let viewModel = SessionViewModel()
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[],"defaultSourceBranch":"josh"}]}
        """.data(using: .utf8)!
        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            throw NSError(domain: "InboxWorktreeDefaultBranchTests", code: 1)
        }
        viewModel.handleWorktreeState(states)

        XCTAssertEqual(viewModel.worktreeState(for: "/repo")?.defaultSourceBranch, "josh",
                       "the recorded default must reach iOS so the inbox action can skip the picker")
    }

    /// A repo with no recorded default decodes to nil, which is what makes the
    /// inbox action fall back to the branch picker — matching the desktop.
    @MainActor
    func testWorktreeStateOmitsDefaultWhenNoneIsRecorded() throws {
        let viewModel = SessionViewModel()
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[]}]}
        """.data(using: .utf8)!
        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            throw NSError(domain: "InboxWorktreeDefaultBranchTests", code: 1)
        }
        viewModel.handleWorktreeState(states)

        XCTAssertNil(viewModel.worktreeState(for: "/repo")?.defaultSourceBranch)
    }

    /// SwiftUI context menus aren't tap-testable here (no ViewInspector), so the
    /// decision is pinned at the source — the same pattern
    /// `InboxConvertToWorktreeTests` uses. The action must branch on the recorded
    /// default: create directly when present, prompt only when absent.
    func testInboxActionUsesRecordedDefaultBeforePrompting() throws {
        let source = try inboxSource
        XCTAssertTrue(source.contains("viewModel.worktreeState(for: effectiveDirectory)?.defaultSourceBranch"),
                      "the action must consult the recorded default before deciding to prompt")
        XCTAssertTrue(source.contains("viewModel.createTab(workingDirectory: effectiveDirectory, useWorktree: true, sourceBranch: defaultBranch)"),
                      "a recorded default must create the worktree conversation directly, with no picker")
        XCTAssertTrue(source.contains("viewModel.requestGitBranches(directory: effectiveDirectory)"),
                      "the branch picker must remain the fallback when no default is recorded")
    }
}
