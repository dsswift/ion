import XCTest
@testable import IonRemote

/// Draft synchronisation with the host.
///
/// The draft is conversation state the host owns and persists, not a local
/// scratchpad, so two things have to hold on the wire: this device's edits
/// encode as `desktop_set_draft`, and the host's value decodes off the tab
/// snapshot. Before this, drafts lived only in UserDefaults here — they
/// survived an app restart on the phone and were invisible everywhere else.
final class DraftSyncTests: XCTestCase {

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Outbound command

    /// Text typed while the transport is wedged is exactly what must not be
    /// lost, so the command is queue-eligible; last-write-wins per conversation
    /// because a draft is idempotent state and an older keystroke would undo a
    /// newer one.
    func testSetDraftIsEssentialAndCollapsesPerConversation() {
        let first = RemoteCommand.setDraft(tabId: "tab-a", text: "half")
        let second = RemoteCommand.setDraft(tabId: "tab-a", text: "half a thought")
        let other = RemoteCommand.setDraft(tabId: "tab-b", text: "different conversation")

        XCTAssertEqual(first.essentialKey, second.essentialKey)
        XCTAssertNotEqual(first.essentialKey, other.essentialKey)
    }

    // MARK: - Inbound projection

    func testTabStateDecodesHostDraft() throws {
        let json = """
        {
            "id": "tab-a",
            "title": "Conversation",
            "status": "idle",
            "workingDirectory": "/src/ion",
            "permissionMode": "auto",
            "permissionQueue": [],
            "draftInput": "typed in Studio"
        }
        """.data(using: .utf8)!

        let tab = try decoder.decode(RemoteTabState.self, from: json)

        XCTAssertEqual(tab.draftInput, "typed in Studio")
    }

    /// A conversation with no draft omits the field rather than sending "",
    /// so the absent case must decode as nil and not as a spurious clear.
    func testTabStateWithoutDraftDecodesNil() throws {
        let json = """
        {
            "id": "tab-a",
            "title": "Conversation",
            "status": "idle",
            "workingDirectory": "/src/ion",
            "permissionMode": "auto",
            "permissionQueue": []
        }
        """.data(using: .utf8)!

        let tab = try decoder.decode(RemoteTabState.self, from: json)

        XCTAssertNil(tab.draftInput)
    }
}
