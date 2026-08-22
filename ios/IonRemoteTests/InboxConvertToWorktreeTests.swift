import XCTest
@testable import IonRemote

/// Inbox row context menu — Convert to worktree.
///
/// The classic tab list's `TabRowContextMenu` already offers "Move
/// conversation into a worktree" for a plain conversation over a known git
/// repo (`viewModel.worktreeStates[tab.workingDirectory] != nil`), routed
/// through `convertConversationToWorktree(tabId:)`. The Inbox view is a
/// second entry point onto conversations and had no equivalent verb — this
/// pins that the Inbox row's context menu offers the identical action, gated
/// by the identical condition, rather than a bespoke or missing mechanism.
///
/// SwiftUI context menus aren't tap-testable in this codebase (no
/// ViewInspector) — see `WorktreeRowSelectConversationTests.swift` and
/// `BenchEphemeralLifecycleTests.testSettleVerbNamesPermanenceOnBothSurfaces`
/// for the established pattern this follows: pin the exact source text of the
/// gate and the verb.
final class InboxConvertToWorktreeTests: XCTestCase {

    private var inboxSource: String {
        get throws {
            let url = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("IonRemote/Views/TabListView+Inbox.swift")
            return try String(contentsOf: url, encoding: .utf8)
        }
    }

    func testInboxRowOffersConvertToWorktreeWithTheSameGateAsTheClassicTabRow() throws {
        let source = try inboxSource
        XCTAssertTrue(source.contains("Move conversation into a worktree"),
                      "the inbox row's context menu must offer the same verb the classic tab row offers")
        XCTAssertTrue(source.contains("tab.worktree == nil && viewModel.worktreeStates[tab.workingDirectory] != nil"),
                      "the gate must match TabRowContextMenu's: absent once the tab already names a worktree, present only for a known repo")
        XCTAssertTrue(source.contains("viewModel.convertConversationToWorktree(tabId: tab.id)"),
                      "the verb must route through the same ViewModel command every other convert entry point uses")
    }

    /// The gate the inbox row reads (`worktreeStates[tab.workingDirectory]`)
    /// resolves from the SAME desktop projection `TabRowContextMenu` reads —
    /// no separate lookup, no separate wire event.
    @MainActor
    func testWorktreeStateLookupMatchesClassicTabRowResolution() throws {
        let viewModel = SessionViewModel()
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[]}]}
        """.data(using: .utf8)!
        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            throw NSError(domain: "InboxConvertToWorktreeTests", code: 1)
        }
        viewModel.handleWorktreeState(states)

        XCTAssertNotNil(viewModel.worktreeStates["/repo"],
                         "a plain repo with a fetched worktree state must resolve, exactly as it does for the classic tab row")
        XCTAssertNil(viewModel.worktreeStates["/unrelated"])
    }
}
