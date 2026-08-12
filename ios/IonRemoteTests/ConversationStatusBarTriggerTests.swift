import XCTest
@testable import IonRemote

/// Pins the trigger-consolidation changes from plan minty-grinning-cocoa:
///
///   1. ConversationStatusBar.onTapContextIndicator — the context-indicator
///      HStack is now wrapped in a Button that fires this callback. The prop
///      defaults to {} so existing call sites without the arg still compile.
///
///   2. Toolbar declutter — the ⓘ info.circle button has been removed from
///      ConversationView.toolbarButtons. Only the three remaining buttons
///      (folder, arrow.triangle.branch, terminal) must exist.
///
/// Both are pure-logic / pure-structural assertions. The callback test calls
/// the static resolver directly (the same pattern ConversationStatusBarWaitingTests
/// uses for resolveRunActivity) to avoid SwiftUI rendering overhead.
final class ConversationStatusBarTriggerTests: XCTestCase {

    // MARK: - onTapContextIndicator callback

    /// The prop exists and defaults to a no-op. This is a compile-time
    /// assertion: if the prop is missing, @testable import fails to resolve
    /// `ConversationStatusBar.init(...)` with the trailing argument.
    func testOnTapContextIndicatorPropExists() {
        // Build a minimal init — only checking the prop is present and callable.
        var called = false
        let bar = ConversationStatusBar(
            modelOverride: nil,
            preferredModel: "claude-sonnet-4-6",
            contextPercent: 42.0,
            contextTokens: nil,
            engineContextWindow: nil,
            isRunning: false,
            permissionMode: nil,
            availableModels: [],
            attachmentCount: 0,
            onSelectModel: { _ in },
            onToggleMode: {},
            onTapAttachments: {},
            onTapContextIndicator: { called = true }
        )
        // The view renders through SwiftUI body evaluation at layout time;
        // we just confirm the closure captured and is callable.
        _ = bar
        // Invoke the closure directly to verify the capture works.
        called = false
        let invoke = bar.onTapContextIndicator
        invoke()
        XCTAssertTrue(called, "onTapContextIndicator closure must be invoked when called")
    }

    /// Default value for onTapContextIndicator must not crash when called.
    func testOnTapContextIndicatorDefaultIsNoOp() {
        let bar = ConversationStatusBar(
            modelOverride: nil,
            preferredModel: "claude-sonnet-4-6",
            contextPercent: nil,
            contextTokens: nil,
            engineContextWindow: nil,
            isRunning: false,
            permissionMode: nil,
            availableModels: [],
            attachmentCount: 0,
            onSelectModel: { _ in },
            onToggleMode: {},
            onTapAttachments: {}
            // onTapContextIndicator intentionally omitted — must compile with default
        )
        // Must not crash
        bar.onTapContextIndicator()
    }

    // MARK: - Toolbar button count

    /// The info.circle button was the fourth button in toolbarButtons.
    /// After removal only three buttons remain (folder, branch, terminal).
    /// This test reads the source file and asserts on the systemName strings
    /// present in toolbarButtons — a structural guard that catches regression
    /// without requiring SwiftUI rendering.
    func testToolbarButtonsDoNotContainInfoCircle() throws {
        let source = try conversationViewSource()

        // The toolbarButtons computed var spans from its declaration to the
        // closing brace. We check the full source for "info.circle" absence
        // since it should not appear at all after removal.
        XCTAssertFalse(
            source.contains("info.circle"),
            "info.circle must not appear anywhere in ConversationView after toolbar declutter"
        )
    }

    /// Verify the three expected buttons are still present after removal.
    func testToolbarButtonsRetainFolderBranchTerminal() throws {
        let source = try conversationViewSource()

        XCTAssertTrue(source.contains("\"folder\""), "folder button must remain in toolbarButtons")
        XCTAssertTrue(source.contains("\"arrow.triangle.branch\""), "branch button must remain in toolbarButtons")
        XCTAssertTrue(source.contains("\"terminal\""), "terminal button must remain in toolbarButtons")
    }

    // MARK: - Source helper

    /// Concatenates every file that declares part of `ConversationView`: the
    /// host file plus its `ConversationView+*.swift` extensions.
    ///
    /// The two guards above pin the *type's* toolbar contract, not a
    /// filename's. Reading only `ConversationView.swift` made them fail the
    /// moment `toolbarButtons` moved to `ConversationView+Layout.swift` for the
    /// 600-line cap, even though the toolbar was unchanged. Globbing the family
    /// keeps each guard pinned to what it actually asserts.
    private func conversationViewSource() throws -> String {
        // #file: .../ios/IonRemoteTests/ConversationStatusBarTriggerTests.swift
        // Sources: .../ios/IonRemote/Views/ConversationView*.swift
        let viewsDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote")
            .appendingPathComponent("Views")
        let names = try FileManager.default
            .contentsOfDirectory(atPath: viewsDir.path)
            .filter { $0 == "ConversationView.swift" || $0.hasPrefix("ConversationView+") }
            .sorted()
        XCTAssertFalse(names.isEmpty, "no ConversationView source files found")
        return try names
            .map { try String(contentsOf: viewsDir.appendingPathComponent($0), encoding: .utf8) }
            .joined(separator: "\n")
    }
}
