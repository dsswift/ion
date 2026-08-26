import XCTest
@testable import IonRemote

final class InboxSnapshotWireTests: XCTestCase {
    func testSnapshotDecodesNavigatorStateAndColdSettledHistory() throws {
        let json = """
        {"type":"desktop_snapshot","tabs":[],"worktreeStates":[{"repoPath":"/repo","worktrees":[],"benches":[]}],
        "settledTabs":[{"id":"settled-1","title":"Review","status":"idle","workingDirectory":"/repo",
        "permissionMode":"auto","permissionQueue":[],"inboxState":"settled","settledAt":123,
        "canRestoreSettled":false,"executionHost":"host-a","executionMachineId":"machine-a"}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case let .snapshot(_, _, _, _, _, _, _, _, _, _, _, _, states, settled) = event else {
            return XCTFail("Expected snapshot")
        }
        XCTAssertEqual(states?.map(\.repoPath), ["/repo"])
        XCTAssertEqual(settled?.map(\.id), ["settled-1"])
        XCTAssertEqual(settled?.first?.executionHost, "host-a")
        XCTAssertEqual(settled?.first?.executionMachineId, "machine-a")
        XCTAssertEqual(settled?.first?.canRestoreSettled, false)
    }

    func testSnapshotDecodesAutomaticSettledProvenance() throws {
        let json = """
        {"type":"desktop_snapshot","tabs":[],"settledTabs":[{"id":"settled-auto","title":"Review","status":"idle","workingDirectory":"/repo",
        "permissionMode":"auto","permissionQueue":[],"inboxState":"settled","settledOverride":"auto","settledAt":123}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case let .snapshot(_, _, _, _, _, _, _, _, _, _, _, _, _, settled) = event else {
            return XCTFail("Expected snapshot")
        }
        XCTAssertEqual(settled?.first?.inboxState, "settled")
        XCTAssertEqual(settled?.first?.settledOverride, "auto")
    }

    func testInboxRowShowsAutoMarkerOnlyForAutomaticSettlement() throws {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/InboxRowView.swift")
        let source = try String(contentsOf: path)

        XCTAssertTrue(source.contains("tab.settledOverride == \"auto\""))
        XCTAssertTrue(source.contains("Text(\"Auto\")"))
        XCTAssertTrue(source.contains("accessibilityLabel(\"Automatically settled\")"))
    }

    func testDeleteConversationCommandUsesDesktopWireType() throws {
        let data = try JSONEncoder().encode(RemoteCommand.tabDelete(tabId: "conversation-1"))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "desktop_tab_delete")
        XCTAssertEqual(object?["tabId"] as? String, "conversation-1")

        let decoded = try JSONDecoder().decode(RemoteCommand.self, from: data)
        guard case .tabDelete(let tabId) = decoded else {
            return XCTFail("Expected tabDelete command")
        }
        XCTAssertEqual(tabId, "conversation-1")
    }

    func testInboxDeleteMenuOffersSettleDeleteAndCancel() throws {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/TabListView.swift")
        let menuPath = path.deletingLastPathComponent().appendingPathComponent("TabListView+Inbox.swift")
        let presentationPath = path.deletingLastPathComponent().appendingPathComponent("TabListView+Presentation.swift")
        let dialog = try String(contentsOf: presentationPath)
        let menu = try String(contentsOf: menuPath)

        XCTAssertTrue(menu.contains("Label(\"Delete conversation…\", systemImage: \"trash\")"))
        XCTAssertTrue(menu.contains("pendingInboxDeleteTab = tab"))
        XCTAssertTrue(dialog.contains("Button(\"Settle Conversation\")"))
        XCTAssertTrue(dialog.contains("Button(\"Delete Conversation\", role: .destructive)"))
        XCTAssertTrue(dialog.contains("Button(\"Cancel\", role: .cancel)"))
        XCTAssertTrue(dialog.contains("viewModel.deleteTab(tabId: tab.id)"))
    }

    func testReviewSettledCommandUsesDesktopWireType() throws {
        let data = try JSONEncoder().encode(RemoteCommand.reviewSettledTab(tabId: "settled-1"))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["type"] as? String, "desktop_review_settled_tab")
        XCTAssertEqual(object?["tabId"] as? String, "settled-1")
    }
}
