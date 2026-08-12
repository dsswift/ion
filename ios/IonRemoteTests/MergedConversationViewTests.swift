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

    /// Reads a view's source across every file that declares part of it: the
    /// host file plus its `Type+Concern.swift` extensions.
    ///
    /// These guards pin the *type's* structural contract, not a filename's.
    /// Reading a single file makes them fail the moment the type is split to
    /// stay under the size cap, even though the contract is intact -- which is
    /// what happened when the view builders moved to
    /// `ConversationView+Layout.swift`. Globbing the family keeps each guard
    /// pinned to the thing it actually asserts and leaves the type free to be
    /// organized across files.
    ///
    /// `testSingleConversationViewStructExists` deliberately keeps using
    /// `read(_:)`: that one is a claim about a specific file (the host file
    /// declares the type), not about the type as a whole.
    private func readFamily(_ typeName: String) throws -> String {
        let names = try FileManager.default
            .contentsOfDirectory(atPath: viewsDir.path)
            .filter { $0 == "\(typeName).swift" || $0.hasPrefix("\(typeName)+") }
            .sorted()
        XCTAssertFalse(names.isEmpty, "no source files found for \(typeName)")
        return try names
            .map { try String(contentsOf: viewsDir.appendingPathComponent($0), encoding: .utf8) }
            .joined(separator: "\n")
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
        let src = try readFamily("ConversationView")
        // The inline toolbar exposes three discrete buttons. `toolbarButtons`
        // lives in ConversationView+Layout.swift and is internal rather than
        // private, because a cross-file extension cannot declare a private
        // member the host file's `body` reaches; the guard is that the member
        // exists on the type, not which file holds it or its access level.
        XCTAssertTrue(src.contains("var toolbarButtons: some View"),
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
        // Every file of the family, not just the host: extracting a subview
        // into ConversationView+Layout.swift would defeat the point if the
        // extraction itself carried an exception marker.
        let src = try readFamily("ConversationView")
        XCTAssertFalse(src.contains("@file-size-exception"),
            "The merged view must stay under the cap via subview extraction, not an exception marker")
    }

    func testAgentPanelIsDataDrivenNotTabTypeGated() throws {
        let src = try readFamily("ConversationView")
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
            "loadEngineConversation must not appear anywhere in ConversationView after WI-004")
    }
}
