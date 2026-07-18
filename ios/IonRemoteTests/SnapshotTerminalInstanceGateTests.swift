import XCTest
@testable import IonRemote

/// Regression: snapshot terminal-instance gate discarded terminal instances
/// on conversation tabs (WI-1B).
///
/// ROOT CAUSE: SessionViewModel+Snapshot.swift's handleSnapshot populated
/// `terminalInstances` / `activeTerminalInstance` only when
/// `tab.isTerminalOnly == true`. The desktop snapshot projects
/// `terminalInstances` for ANY tab with a terminal pane — conversation tabs
/// included — so a conversation tab's terminal instances were silently
/// dropped and its terminal pane rendered empty.
///
/// FIX: gate purely on the presence of `terminalInstances` in the snapshot
/// (data-driven, same rationale as the conversationInstances handling in the
/// same function).
///
/// The discriminator: restoring the `tab.isTerminalOnly == true` condition
/// makes the non-terminal-only assertions below fail.
@MainActor
final class SnapshotTerminalInstanceGateTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Helpers

    /// Build a minimal snapshot JSON with one tab carrying two terminal
    /// instances. `isTerminalOnlyJSON` is spliced raw so the test can cover
    /// `false`, `true`, and field-absent (nil) shapes.
    private func snapshotJSON(isTerminalOnlyJSON: String?, activeId: String?) -> Data {
        let terminalOnlyLine = isTerminalOnlyJSON.map { "\"isTerminalOnly\":\($0)," } ?? ""
        let activeLine = activeId.map { "\"activeTerminalInstanceId\":\"\($0)\"," } ?? ""
        let json = """
        {"type":"desktop_snapshot","tabs":[{
          "id":"tab-1",
          "title":"Test Tab",
          "customTitle":null,
          "status":"idle",
          "workingDirectory":"/tmp",
          "permissionMode":"auto",
          "permissionQueue":[],
          \(terminalOnlyLine)
          \(activeLine)
          "terminalInstances":[
            {"id":"term-a","label":"zsh","kind":"shell","readOnly":false,"cwd":"/tmp"},
            {"id":"term-b","label":"logs","kind":"shell","readOnly":true,"cwd":"/tmp"}
          ],
          "lastMessage":null,
          "contextTokens":null
        }]}
        """
        return json.data(using: .utf8)!
    }

    private func applySnapshot(isTerminalOnlyJSON: String?, activeId: String? = nil) throws -> SessionViewModel {
        let vm = SessionViewModel()
        let data = snapshotJSON(isTerminalOnlyJSON: isTerminalOnlyJSON, activeId: activeId)
        let event = try decoder.decode(RemoteEvent.self, from: data)
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _) = event else {
            XCTFail("Expected snapshot"); return vm
        }
        XCTAssertEqual(tabs[0].terminalInstances?.count, 2, "pre-condition: raw snapshot carries the instances")
        vm.handleSnapshot(snapshotTabs: tabs, recentDirs: [], groupMode: nil, groups: nil)
        return vm
    }

    // MARK: - Conversation tabs (isTerminalOnly false / absent) get terminal state

    func testConversationTabWithTerminalInstancesPopulatesState() throws {
        let vm = try applySnapshot(isTerminalOnlyJSON: "false")
        XCTAssertEqual(vm.terminalInstances["tab-1"]?.map(\.id), ["term-a", "term-b"],
            "a conversation tab (isTerminalOnly == false) whose snapshot carries terminalInstances must populate terminal state")
        XCTAssertEqual(vm.activeTerminalInstance["tab-1"], "term-a",
            "active instance falls back to the first instance when the snapshot has no activeTerminalInstanceId")
    }

    func testTabWithoutIsTerminalOnlyFieldPopulatesState() throws {
        let vm = try applySnapshot(isTerminalOnlyJSON: nil)
        XCTAssertEqual(vm.terminalInstances["tab-1"]?.map(\.id), ["term-a", "term-b"],
            "a tab with the isTerminalOnly field absent (nil) must still populate terminal state from the snapshot")
    }

    func testActiveTerminalInstanceIdFromSnapshotWins() throws {
        let vm = try applySnapshot(isTerminalOnlyJSON: "false", activeId: "term-b")
        XCTAssertEqual(vm.activeTerminalInstance["tab-1"], "term-b",
            "the snapshot's explicit activeTerminalInstanceId must win over the first-instance fallback")
    }

    // MARK: - Terminal-only tabs still work (no regression)

    func testTerminalOnlyTabStillPopulatesState() throws {
        let vm = try applySnapshot(isTerminalOnlyJSON: "true")
        XCTAssertEqual(vm.terminalInstances["tab-1"]?.map(\.id), ["term-a", "term-b"],
            "terminal-only tabs must keep populating terminal state (pre-fix behavior preserved)")
        XCTAssertEqual(vm.activeTerminalInstance["tab-1"], "term-a")
    }
}
