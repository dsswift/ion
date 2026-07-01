import XCTest
@testable import IonRemote

/// Phase 6 of the #256 iOS unification: the merged conversation view.
///
/// EngineView and the old ConversationView were merged into a single
/// ConversationView that renders every non-terminal tab — plain or engine —
/// with engine-only chrome gated on `tabHasExtensions`. SwiftUI view bodies are
/// not introspectable in unit tests, so these guard tests pin the structural
/// contracts of the merge against the source files:
///
///   1. There is exactly one conversation view type — the separate EngineView
///      no longer exists.
///   2. The header uses the inline three-button toolbar (folder / git / terminal)
///      for all tabs, not a collapsed overflow Menu (the explicit operator
///      directive — the merged view inherits the engine view's mature header).
///   3. The merged view file carries no file-size-exception marker (the merge
///      extracted subviews instead of inheriting EngineView's allowlist).
final class MergedConversationViewTests: XCTestCase {

    private var viewsDir: URL {
        // .../ios/IonRemoteTests/<thisfile> -> .../ios/IonRemote/Views
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()        // IonRemoteTests
            .deletingLastPathComponent()        // ios
            .appendingPathComponent("IonRemote/Views")
    }

    private func read(_ name: String) throws -> String {
        try String(contentsOf: viewsDir.appendingPathComponent(name), encoding: .utf8)
    }

    func testEngineViewFileNoLongerExists() {
        let engineView = viewsDir.appendingPathComponent("EngineView.swift")
        XCTAssertFalse(FileManager.default.fileExists(atPath: engineView.path),
            "EngineView.swift must be gone — merged into ConversationView (#256)")
    }

    func testSingleConversationViewStructExists() throws {
        let src = try read("ConversationView.swift")
        XCTAssertTrue(src.contains("struct ConversationView: View"),
            "The merged view must be named ConversationView")
        XCTAssertFalse(src.contains("struct EngineView"),
            "No EngineView struct should remain")
    }

    func testHeaderUsesInlineThreeButtonToolbar() throws {
        let src = try read("ConversationView.swift")
        // The inline toolbar exposes three discrete buttons.
        XCTAssertTrue(src.contains("private var toolbarButtons: some View"),
            "Inline toolbarButtons must exist")
        XCTAssertTrue(src.contains("HStack(spacing: 12)"),
            "Toolbar buttons render inline in an HStack")
        for glyph in ["\"folder\"", "\"arrow.triangle.branch\"", "\"terminal\""] {
            XCTAssertTrue(src.contains(glyph), "Inline toolbar must contain \(glyph) button")
        }
        // No collapsed overflow menu in the toolbar (the old plain-tab pattern).
        XCTAssertFalse(src.contains("square.grid.2x2"),
            "The collapsed overflow Menu (square.grid.2x2) must be gone — buttons are inline")
    }

    func testMergedViewHasNoFileSizeException() throws {
        let src = try read("ConversationView.swift")
        XCTAssertFalse(src.contains("@file-size-exception"),
            "The merged view must stay under the cap via subview extraction, not an exception marker")
    }

    func testAgentPanelIsDataDrivenNotTabTypeGated() throws {
        let src = try read("ConversationView.swift")
        // #256 follow-up: the agent panel renders on DATA (non-empty agents),
        // NOT on a tab-type flag. The former `tabHasExtensions && …` gate is
        // gone — a plain conversation that dispatches background sub-agents must
        // show them.
        XCTAssertFalse(src.contains("tabHasExtensions && !visibleAgents.isEmpty"),
            "The agent panel must NOT be gated on tabHasExtensions — that was the illegitimate tab-type fork removed in the #256 follow-up")
        // The agents parameter uses a ternary to pass nil when the list is empty,
        // not an `if` branch. Both forms are data-driven; what matters is that the
        // value is derived solely from visibleAgents (no tab-type gate).
        XCTAssertTrue(src.contains("agents: visibleAgents.isEmpty ? nil : visibleAgents"),
            "The agent panel must be driven purely by the data: visibleAgents.isEmpty ternary with no tab-type gate")
        // A reintroduced tab-type guard would combine tabHasExtensions with the agents ternary.
        XCTAssertFalse(src.contains("tabHasExtensions && visibleAgents.isEmpty"),
            "No tab-type guard may be combined with the visibleAgents.isEmpty ternary")

        // WI-004 / #259: history load routing is no longer a legitimate use of
        // tabHasExtensions. loadConversationHistory now calls loadConversation
        // for every tab — no fork on tab type.
        XCTAssertFalse(src.contains("if tabHasExtensions {") && src.contains("loadEngineConversation"),
            "loadConversationHistory must not fork on tabHasExtensions after WI-004 retirement")
        XCTAssertFalse(src.contains("loadEngineConversation"),
            "loadEngineConversation must not appear in ConversationView.swift after WI-004")
    }
}
