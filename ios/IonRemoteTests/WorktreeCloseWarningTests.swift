import XCTest
@testable import IonRemote

/// Closing a worktree conversation on iOS must say what is being left behind.
///
/// ── The parity gap these pin ────────────────────────────────────────────────
/// The desktop warns before closing a conversation whose worktree still holds
/// uncommitted changes or unlanded commits. iOS closed tabs by swipe-delete with
/// no confirmation at all, so the identical close was silent on the phone — even
/// though the snapshot already carries `isDirty` and `unlandedCommitCount` and
/// the Worktrees screen renders both.
///
/// These fail against a build with no `WorktreeCloseWarning`: there is nothing to
/// produce the summary.
final class WorktreeCloseWarningTests: XCTestCase {

    private let worktreePath = "/Users/test/.ion/worktrees/ion-a3f1"

    private func makeTab(directory: String) -> RemoteTabState {
        RemoteTabState(
            id: "tab-wt",
            title: "Worktree work",
            customTitle: nil,
            status: .idle,
            workingDirectory: directory,
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: []
        )
    }

    /// Built by decoding JSON rather than a memberwise init: `RemoteWorktree`
    /// declares `init(from decoder:)` in its body, which suppresses the
    /// memberwise initialiser. Decoding also pins the wire keys the desktop
    /// actually sends, so a snapshot-shape change surfaces here.
    private func makeWorktree(
        isDirty: Bool = false,
        unlandedCommitCount: Int = 0,
        operationState: String? = nil
    ) throws -> RemoteWorktree {
        var payload: [String: Any] = [
            "worktreePath": worktreePath,
            "branchName": "wt/ion-a3f1",
            "label": "ion-a3f1",
            "sourceBranch": "main",
            "head": "abc1234",
            "lastCommitSubject": "work in progress",
            "isDirty": isDirty,
            "unlandedCommitCount": unlandedCommitCount,
            "needsSync": false,
            "safeToDiscard": !isDirty && unlandedCommitCount == 0,
        ]
        if let operationState {
            payload["operationState"] = operationState
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(RemoteWorktree.self, from: data)
    }

    private func states(_ worktrees: [RemoteWorktree]) -> [String: RemoteWorktreeState] {
        let state = RemoteWorktreeState(
            repoPath: "/Users/test/src/ion",
            worktrees: worktrees,
            benches: []
        )
        return [state.repoPath: state]
    }

    // MARK: - Silence for uneventful closes

    func testPlainConversationProducesNoWarning() throws {
        let summary = WorktreeCloseWarning.summary(
            for: makeTab(directory: "/Users/test/src/ion"),
            worktreeStates: states([try makeWorktree()])
        )

        XCTAssertNil(summary, "a conversation that is not in a worktree must close silently")
    }

    func testCleanFullyLandedWorktreeProducesNoWarning() throws {
        let summary = WorktreeCloseWarning.summary(
            for: makeTab(directory: worktreePath),
            worktreeStates: states([try makeWorktree()])
        )

        XCTAssertNil(summary, "a clean, landed worktree has nothing to warn about")
    }

    /// A directory that merely LOOKS like a worktree path is not one: resolution
    /// reads the desktop's projection, never the path shape.
    func testUnregisteredWorktreePathProducesNoWarning() throws {
        let summary = WorktreeCloseWarning.summary(
            for: makeTab(directory: "/Users/test/.ion/worktrees/not-registered"),
            worktreeStates: states([try makeWorktree()])
        )

        XCTAssertNil(summary)
    }

    // MARK: - Warnings

    func testWarnsAboutUnlandedCommits() throws {
        let summary = try XCTUnwrap(WorktreeCloseWarning.summary(
            for: makeTab(directory: worktreePath),
            worktreeStates: states([try makeWorktree(unlandedCommitCount: 4)])
        ))

        XCTAssertTrue(summary.contains("4 commits not yet landed"), summary)
        // Reassurance is part of the contract on both clients: the close is not
        // destructive and the operator must know how to get back.
        XCTAssertTrue(summary.lowercased().contains("nothing is deleted"), summary)
        XCTAssertTrue(summary.contains("Inbox"), summary)
    }

    func testSingularisesOneCommit() throws {
        let summary = try XCTUnwrap(WorktreeCloseWarning.summary(
            for: makeTab(directory: worktreePath),
            worktreeStates: states([try makeWorktree(unlandedCommitCount: 1)])
        ))

        XCTAssertTrue(summary.contains("1 commit not yet landed"), summary)
        XCTAssertFalse(summary.contains("1 commits"), summary)
    }

    func testWarnsAboutUncommittedChanges() throws {
        let summary = try XCTUnwrap(WorktreeCloseWarning.summary(
            for: makeTab(directory: worktreePath),
            worktreeStates: states([try makeWorktree(isDirty: true)])
        ))

        XCTAssertTrue(summary.contains("uncommitted changes"), summary)
    }

    func testReportsBothProblemsTogether() throws {
        let summary = try XCTUnwrap(WorktreeCloseWarning.summary(
            for: makeTab(directory: worktreePath),
            worktreeStates: states([try makeWorktree(isDirty: true, unlandedCommitCount: 2)])
        ))

        XCTAssertTrue(summary.contains("uncommitted changes"), summary)
        XCTAssertTrue(summary.contains("2 commits not yet landed"), summary)
    }

    /// Mid-operation the appraisal fields are conservative defaults rather than
    /// live answers, so a conflicted worktree must never read as "nothing to
    /// lose" just because its counts came back zero.
    func testWarnsWhileAnOperationIsInProgress() throws {
        for (state, expected) in [
            ("rebasing", "mid-rebase"),
            ("merging", "mid-merge"),
            ("cherry-picking", "mid-cherry-pick"),
        ] {
            let summary = try XCTUnwrap(WorktreeCloseWarning.summary(
                for: makeTab(directory: worktreePath),
                worktreeStates: states([try makeWorktree(operationState: state)])
            ))
            XCTAssertTrue(summary.contains(expected), summary)
        }
    }

    // MARK: - Resolution

    func testResolvesTheWorktreeForATab() throws {
        let resolved = WorktreeCloseWarning.resolve(
            tab: makeTab(directory: worktreePath),
            in: states([try makeWorktree()])
        )

        XCTAssertEqual(resolved?.worktreePath, worktreePath)
    }
}
