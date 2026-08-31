import XCTest
@testable import IonRemote

final class ConversationClipboardActionsTests: XCTestCase {
    func testCanonicalSessionIdsArePreferredAndDeduplicated() throws {
        let tab = try decodeTab(extra: #""sessionIds":["old","current","old"],"conversationId":"fallback""#)
        XCTAssertEqual(ConversationClipboardActions.resolveSessionIds(tab: tab, fallbackInstance: nil), ["old", "current"])
    }

    func testEngineSessionLedgerIsCompatibilityFallback() throws {
        let tab = try decodeTab(extra: #""hasEngineExtension":true"#)
        var instance = ConversationInstanceInfo(id: "main", label: "Main")
        instance.conversationIds = ["old", "current", "old"]

        XCTAssertEqual(
            ConversationClipboardActions.resolveSessionIds(tab: tab, fallbackInstance: instance),
            ["old", "current"]
        )
    }

    func testPlainConversationIdIsCompatibilityFallback() throws {
        let tab = try decodeTab(extra: #""conversationId":"legacy""#)
        XCTAssertEqual(ConversationClipboardActions.resolveSessionIds(tab: tab, fallbackInstance: nil), ["legacy"])
    }

    func testEveryConversationListMountsSharedActions() throws {
        let views = ["TabRowContextMenu.swift", "TabListView+Inbox.swift", "InboxSettledHistorySheet.swift"]
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views")

        for name in views {
            let source = try String(contentsOf: root.appendingPathComponent(name))
            XCTAssertTrue(source.contains("ConversationClipboardActions(tab: tab)"), "Missing shared actions in \(name)")
        }
    }

    private func decodeTab(extra: String) throws -> RemoteTabState {
        let data = """
        {"id":"tab-1","title":"Test","status":"idle","workingDirectory":"/tmp",
        "permissionMode":"auto","permissionQueue":[],\(extra)}
        """.data(using: .utf8)!
        return try JSONDecoder().decode(RemoteTabState.self, from: data)
    }
}
