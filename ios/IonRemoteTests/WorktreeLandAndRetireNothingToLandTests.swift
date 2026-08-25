import XCTest
@testable import IonRemote

/// "Land and retire" covers "nothing to land".
///
/// A worktree with zero unlanded commits (a mistakenly created worktree, or
/// work abandoned before the first commit) used to disable the verb entirely
/// on both surfaces it appears on — the classic tab row's context menu
/// (`TabRowContextMenu`) and the Inbox worktree card (`WorktreeRowView`) — so
/// there was no menu path to discard it. Both now enable the row for this
/// case and label it honestly as a discard rather than a merge, mirroring the
/// desktop's `canLandWorktree` / `landRefusalReason`
/// (WorktreeRowMenu.items.tsx): a dirty checkout or unknown source branch
/// still refuses, but zero unlanded commits does not.
///
/// SwiftUI context menus aren't tap-testable in this codebase (no
/// ViewInspector) — see `BenchEphemeralLifecycleTests.swift` and
/// `WorktreeOpResultWireTests.testTabRowUsesTerminalLandAndRetireAction` for
/// the established pattern this follows: pin the exact source text of the
/// gate and the label.
final class WorktreeLandAndRetireNothingToLandTests: XCTestCase {

    private func source(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testTabRowContextMenuNoLongerGatesOnUnlandedCommitCount() throws {
        let source = try source("IonRemote/Views/TabRowContextMenu.swift")

        XCTAssertFalse(source.contains(".disabled(wt.isDirty || wt.unlandedCommitCount == 0)"),
                        "the old gate must be gone: dirty alone is the only remaining disqualifier")
        XCTAssertTrue(source.contains(".disabled(wt.isDirty)"),
                       "dirty must still refuse — landing uncommitted work is never safe")
        XCTAssertTrue(source.contains("wt.unlandedCommitCount == 0 ? .destructive : nil"),
                       "a nothing-to-land row must still read as destructive, since it discards the worktree")
        XCTAssertTrue(source.contains("\"Retire (nothing to land)\""),
                      "the label must say discard, not merge, when there is nothing to land")
    }

    func testInboxWorktreeRowUsesConfirmedDiscardAction() throws {
        let row = try source("IonRemote/Views/WorktreeRowView.swift")
        let group = try source("IonRemote/Views/InboxWorktreeGroup.swift")

        XCTAssertTrue(row.contains("Label(\"Discard worktree\", systemImage: \"trash\")"),
                      "the Inbox worktree menu must name the non-merge removal action")
        XCTAssertTrue(group.contains("Button(\"Discard worktree\", role: .destructive)"),
                      "the Inbox must require a destructive confirmation before discard")
        XCTAssertTrue(group.contains("Nothing merges into its source branch."),
                      "the confirmation must state that discard cannot land work")
    }
}
