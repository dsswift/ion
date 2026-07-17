import XCTest
@testable import IonRemote

/// Defect A (iOS): a live user echo for a fresh, not-yet-loaded conversation
/// must render the user bubble.
///
/// Before the fix, `handleMessageAdded` short-circuited with
/// `guard conversationLoaded.contains(tabId) else { return }`, so an
/// iOS-started slash command on a fresh extension-hosted conversation — where
/// no history had loaded yet — dropped the desktop_message_added user echo and
/// NO user bubble appeared. The desktop forwards a user echo as a
/// desktop_message_added from its own remote-prompt path; for user/assistant
/// roles iOS marks the conversation loaded and inserts, then reconciles by id
/// so a later history reload heals without duplication.
@MainActor
final class MessageAddedFreshConversationTests: XCTestCase {

    private func makeMessage(id: String, role: MessageRole, content: String) -> Message {
        Message(id: id, role: role, content: content, timestamp: 1_700_000_000_000)
    }

    func testUserEchoRendersOnNotYetLoadedConversation() {
        let vm = SessionViewModel()
        // Conversation has NOT been loaded — the fresh-from-iOS slash case.
        XCTAssertFalse(vm.conversationLoaded.contains("fresh"))

        vm.handleMessageAdded(
            tabId: "fresh",
            message: makeMessage(id: "entry-1", role: .user, content: "/align the docs"),
        )

        // The user bubble renders despite the conversation not being loaded,
        // and the conversation is now marked loaded so subsequent live events
        // and the eventual history reload reconcile against it.
        XCTAssertTrue(vm.conversationLoaded.contains("fresh"))
        let msgs = vm.conversationMessages("fresh")
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs.first?.id, "entry-1")
        XCTAssertEqual(msgs.first?.content, "/align the docs")
        XCTAssertEqual(msgs.first?.role, .user)
    }

    func testSecondEchoReconcilesByIdWithoutDuplicating() {
        let vm = SessionViewModel()

        vm.handleMessageAdded(
            tabId: "fresh",
            message: makeMessage(id: "entry-1", role: .user, content: "/align the docs"),
        )
        // A second event for the same entryId (e.g. the canonical version after
        // a history reload, or a re-broadcast) must replace by id, not append.
        vm.handleMessageAdded(
            tabId: "fresh",
            message: makeMessage(id: "entry-1", role: .user, content: "/align the docs"),
        )

        let msgs = vm.conversationMessages("fresh")
        XCTAssertEqual(msgs.count, 1, "same entryId must reconcile, not duplicate")
        XCTAssertEqual(msgs.first?.id, "entry-1")
    }

    // MARK: - lastMessage marker stripping

    private func makeTab(id: String) -> RemoteTabState {
        RemoteTabState(
            id: id,
            title: id,
            customTitle: nil,
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: [],
            hasEngineExtension: false
        )
    }

    /// `handleMessageAdded` must strip `[Attached image: PATH]` markers before
    /// storing `lastMessage`, so the tab row subtitle shows the user's text
    /// rather than the raw attachment marker.
    func testLastMessageStripsAttachedImageMarker() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab1")]
        let content = "[Attached image: /Users/josh/Desktop/screenshot.png]\n\nwhat is this?"
        vm.handleMessageAdded(
            tabId: "tab1",
            message: Message(id: "m1", role: .user, content: content, timestamp: 1_700_000_000_000),
        )
        // lastMessage must not contain the raw marker.
        let lastMsg = vm.tabs.first(where: { $0.id == "tab1" })?.lastMessage ?? ""
        XCTAssertFalse(lastMsg.contains("[Attached image:"), "raw marker must not appear in tab row subtitle")
        XCTAssertFalse(lastMsg.contains("[Attached"), "no marker form must appear in tab row subtitle")
        // The stripped user text must survive.
        XCTAssertTrue(lastMsg.contains("what is this?"), "user text must appear in tab row subtitle after stripping")
    }

    /// Same stripping for the post-encode `[Attachment: NAME (content attached)]`
    /// form produced by attachment-encoder.ts after base64 encoding.
    func testLastMessageStripsContentAttachedMarker() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab2")]
        let content = "[Attachment: screenshot.png (content attached)]\n\nwhat is this?"
        vm.handleMessageAdded(
            tabId: "tab2",
            message: Message(id: "m2", role: .user, content: content, timestamp: 1_700_000_000_000),
        )
        let lastMsg = vm.tabs.first(where: { $0.id == "tab2" })?.lastMessage ?? ""
        XCTAssertFalse(lastMsg.contains("[Attachment:"), "post-encode marker must not appear in tab row subtitle")
        XCTAssertTrue(lastMsg.contains("what is this?"), "user text must appear in tab row subtitle after stripping")
    }

    /// When content is ONLY a marker (no trailing text), lastMessage must not
    /// be empty — the fallback to raw content prefix kicks in so the tab row
    /// still shows something rather than a blank subtitle. The critical invariant
    /// is: clean text IS preserved when present; marker-only falls back gracefully.
    func testLastMessageMarkerOnlyFallsBackGracefully() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab3")]
        let content = "[Attached image: /tmp/photo.jpg]"
        vm.handleMessageAdded(
            tabId: "tab3",
            message: Message(id: "m3", role: .user, content: content, timestamp: 1_700_000_000_000),
        )
        // segments.text is empty for marker-only content; the fallback to raw
        // content means the marker may appear in the subtitle, but the path is
        // exercised without crash and the subtitle is non-empty.
        let lastMsg = vm.tabs.first(where: { $0.id == "tab3" })?.lastMessage ?? ""
        XCTAssertFalse(lastMsg.isEmpty, "lastMessage must not be empty for a sent message")
    }

    func testNonUserRoleStillGuardedOnNotYetLoaded() {
        let vm = SessionViewModel()
        // A tool message on a not-yet-loaded conversation keeps the original
        // guard — only user/assistant echoes bypass it.
        vm.handleMessageAdded(
            tabId: "fresh",
            message: makeMessage(id: "t1", role: .tool, content: "tool output"),
        )
        XCTAssertFalse(vm.conversationLoaded.contains("fresh"))
        XCTAssertEqual(vm.conversationMessages("fresh").count, 0)
    }
}
