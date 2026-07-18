import XCTest
@testable import IonRemote

/// RC-9 / RC-10: precise optimistic↔canonical reconciliation in the first-page
/// history merge (`handleConversationHistory`, before == nil branch).
///
/// The duplicate-user-below-agent bug: an optimistic user row is keyed by the
/// clientMsgId this device sent, but the persisted history row carries the
/// engine's CANONICAL entry id. When the live re-key events (user_turn_persisted
/// / message_end) are dropped, the two ids differ, so an id-only "is this row in
/// the page?" check kept the stale optimistic row and appended it BELOW the
/// assistant reply. The desktop now annotates the history user row with the
/// clientMsgId it was submitted under; iOS collapses on that.
///
/// RC-10: an assistant row whose id was never re-keyed duplicated the canonical
/// assistant row already in the page; the merge now drops a trailing tail
/// assistant whose content matches the page's last assistant row.
@MainActor
final class ConversationMergeReconcileTests: XCTestCase {

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

    /// Optimistic user row (id = clientMsgId) + canonical history user row whose
    /// id differs but whose clientMsgId matches → exactly one user row, and it is
    /// positioned ABOVE the assistant reply (canonical order), not below.
    func testOptimisticUserCollapsedByClientMsgIdDespiteRekeyMiss() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t")]

        // User submits; optimistic row keyed by clientMsgId.
        vm.submit(tabId: "t", text: "explain this")
        let clientId = vm.conversationMessages("t").first { $0.role == .user }?.id
        XCTAssertNotNil(clientId)

        // Simulate a live assistant reply streaming in AFTER the user turn, still
        // keyed by a local UUID (message_end re-key was dropped).
        var liveAssistant = Message(id: "live-uuid", role: .assistant, content: "here is why", timestamp: 1_700_000_002_000)
        liveAssistant.source = .remote
        vm.mutateConversationMessages(tabId: "t") { $0.append(liveAssistant) }

        // First-page history arrives: canonical user row (DIFFERENT id) carrying
        // the clientMsgId annotation, followed by the canonical assistant row.
        var canonicalUser = Message(id: "entry-user-canonical", role: .user, content: "explain this", timestamp: 1_700_000_001_000)
        canonicalUser.clientMsgId = clientId
        let canonicalAssistant = Message(id: "entry-asst-canonical", role: .assistant, content: "here is why", timestamp: 1_700_000_002_000)
        vm.handleConversationHistory(tabId: "t", newMessages: [canonicalUser, canonicalAssistant], hasMore: false, cursor: nil)

        let msgs = vm.conversationMessages("t")
        let users = msgs.filter { $0.role == .user }
        let assistants = msgs.filter { $0.role == .assistant }
        XCTAssertEqual(users.count, 1, "optimistic user must collapse against the canonical row by clientMsgId (no duplicate)")
        XCTAssertEqual(assistants.count, 1, "un-re-keyed live assistant must collapse against the canonical row by content (RC-10)")
        // Order: user before assistant (canonical), not user below the reply.
        let userIdx = msgs.firstIndex { $0.role == .user }!
        let asstIdx = msgs.firstIndex { $0.role == .assistant }!
        XCTAssertLessThan(userIdx, asstIdx, "user turn must render ABOVE the assistant reply")
        // The surviving user row is the canonical one.
        XCTAssertEqual(users.first?.id, "entry-user-canonical")
    }

    /// When the page does NOT contain the optimistic row (by id or clientMsgId),
    /// the optimistic row is genuinely pending and must be preserved below the
    /// history — the existing behavior must not regress.
    func testGenuinelyPendingOptimisticSurvives() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t")]

        vm.submit(tabId: "t", text: "brand new turn")
        let clientId = vm.conversationMessages("t").first { $0.role == .user }?.id

        // History page from BEFORE this turn — no matching id or clientMsgId.
        let older = Message(id: "old-entry", role: .assistant, content: "old reply", timestamp: 1_699_000_000_000)
        vm.handleConversationHistory(tabId: "t", newMessages: [older], hasMore: false, cursor: nil)

        let users = vm.conversationMessages("t").filter { $0.role == .user }
        XCTAssertEqual(users.count, 1, "a genuinely pending optimistic row must survive the replace")
        XCTAssertEqual(users.first?.id, clientId)
        // And it must be below the history.
        let msgs = vm.conversationMessages("t")
        XCTAssertEqual(msgs.last?.id, clientId, "pending optimistic goes below the persisted history")
    }

    /// RC-11: a live tail with nil/equal timestamps survives a first-page replace
    /// when no id anchors. The old timestamp heuristic dropped it; the isLive
    /// boundary preserves it.
    func testLiveTailSurvivesReplaceWithNilTimestamps() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t")]

        // A live streaming assistant row appended with NO timestamp and a
        // non-canonical id (message_end re-key not yet arrived). Mark it live the
        // way the live handlers do.
        var liveRow = Message(id: "live-1", role: .assistant, content: "streaming reply", timestamp: nil)
        liveRow.isLive = true
        vm.mutateConversationMessages(tabId: "t") { $0.append(liveRow) }

        // First-page history whose rows ALSO have no timestamps, none matching the
        // live row's id — the exact case the timestamp fallback mishandled.
        let hist = Message(id: "hist-1", role: .user, content: "earlier question", timestamp: nil)
        vm.handleConversationHistory(tabId: "t", newMessages: [hist], hasMore: false, cursor: nil)

        let msgs = vm.conversationMessages("t")
        XCTAssertTrue(msgs.contains { $0.id == "live-1" },
            "the live tail row must survive a first-page replace via the isLive boundary, not be dropped by a timestamp estimate")
        // And it stays below the persisted history.
        XCTAssertEqual(msgs.last?.id, "live-1")
    }

    /// RC-13: a reconnect/heal reload during an active run must NOT wipe the relay
    /// text_chunk accumulator (liveText) — that blanked the in-flight streaming
    /// bubble on resume. A settled (non-reconnect) load still clears it.
    func testReconnectHealDuringRunDoesNotBlankLiveText() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "t")
        tab.status = .running
        vm.tabs = [tab]

        // Relay stream in progress: text accrued in liveText.
        vm.appendLiveText(tabId: "t", "partial streaming answer")
        XCTAssertEqual(vm.liveText("t"), "partial streaming answer")

        // A reconnect snapshot fires loadConversation mid-run.
        vm.isReconnectSnapshot = true
        vm.handleConversationHistory(tabId: "t", newMessages: [], hasMore: false, cursor: nil)
        vm.isReconnectSnapshot = false

        XCTAssertEqual(vm.liveText("t"), "partial streaming answer",
            "a reconnect heal during an active run must not blank the in-flight relay text")
    }

    /// A normal (non-reconnect) load still clears liveText — no regression.
    func testNormalLoadClearsLiveText() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t")]
        vm.appendLiveText(tabId: "t", "stale live text")

        vm.handleConversationHistory(tabId: "t", newMessages: [], hasMore: false, cursor: nil)

        XCTAssertEqual(vm.liveText("t"), "", "a settled first load clears the live accumulator")
    }
}
