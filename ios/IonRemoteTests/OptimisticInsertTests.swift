import XCTest
@testable import IonRemote

/// Pins the three behavioral guarantees of the unconditional optimistic insert:
///
/// 1. The optimistic user bubble fires even when the conversation has not been
///    loaded yet (the `conversationLoaded` gate was removed from `submit`).
/// 2. An un-echoed optimistic message survives a concurrent full history
///    replace (the merge logic in `handleConversationHistory` retains it).
/// 3. After a history replace, the subsequent desktop echo reconciles by
///    `clientMsgId` to exactly one user bubble (no duplicate).
///
/// These three tests fail without the corresponding fixes:
/// - Test 1 fails unless the `if conversationLoaded.contains(tabId)` gate is
///   removed from SessionViewModel+Submit.swift.
/// - Tests 2 and 3 fail unless the pending-optimistic merge is applied in
///   the `before == nil` (wholesale-replace) branch of `handleConversationHistory`.
@MainActor
final class OptimisticInsertTests: XCTestCase {

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

    private func assistantMessage(id: String) -> Message {
        Message(id: id, role: .assistant, content: "response", timestamp: 1_700_000_000_000)
    }

    // MARK: - Test 1: optimistic insert fires on not-yet-loaded conversation

    /// The optimistic user bubble must appear immediately when `submit` is
    /// called, even if the conversation has never been loaded (fresh tab or
    /// just-reloaded tab where `conversationLoaded` was cleared). This was
    /// broken by the `if conversationLoaded.contains(tabId)` gate.
    func testOptimisticInsertFiresOnNotYetLoadedConversation() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab1")]

        // Conversation has NOT been loaded.
        XCTAssertFalse(vm.conversationLoaded.contains("tab1"),
            "Precondition: tab must not be in conversationLoaded")

        vm.submit(tabId: "tab1", text: "hello world")

        let msgs = vm.conversationMessages("tab1")
        XCTAssertEqual(msgs.count, 1,
            "Optimistic user bubble must appear immediately regardless of conversationLoaded state")
        XCTAssertEqual(msgs.first?.role, .user)
        XCTAssertEqual(msgs.first?.content, "hello world")
        XCTAssertEqual(msgs.first?.source, .remote)
    }

    // MARK: - Test 2: un-echoed optimistic survives a concurrent history replace

    /// If a history response arrives BEFORE the desktop echoes the user
    /// message back, the optimistic insert must not be wiped by the full
    /// replace. Without the merge logic, `setConversationMessages` would
    /// overwrite the list with only the canonical history, dropping the
    /// optimistic bubble and producing the MISSING symptom again.
    func testOptimisticMessageSurvivesConcurrentHistoryReplace() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab2")]

        // Submit before the conversation is loaded — inserts optimistic message.
        vm.submit(tabId: "tab2", text: "first message")
        let optimisticId = vm.conversationMessages("tab2").first { $0.role == .user }?.id
        XCTAssertNotNil(optimisticId, "Precondition: optimistic message must have been inserted")

        // History replace arrives with unrelated server messages — no echo yet.
        let serverMsgs = [assistantMessage(id: "srv-001"), assistantMessage(id: "srv-002")]
        vm.handleConversationHistory(tabId: "tab2", newMessages: serverMsgs, hasMore: false, cursor: nil)

        // The optimistic user message must still be present.
        let allMsgs = vm.conversationMessages("tab2")
        let userMsgs = allMsgs.filter { $0.role == .user }
        XCTAssertEqual(userMsgs.count, 1,
            "Un-echoed optimistic user message must survive a concurrent full history replace")
        XCTAssertEqual(userMsgs.first?.id, optimisticId)
    }

    // MARK: - Test 3: echo after history replace reconciles to exactly one bubble

    /// After the history replace preserves the optimistic message, the
    /// subsequent desktop echo must reconcile by id to leave exactly one
    /// user bubble — not a duplicate.
    func testEchoAfterHistoryReplaceReconcilesToOneBubble() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab3")]

        // Submit — inserts optimistic.
        vm.submit(tabId: "tab3", text: "second message")
        let optimisticId = vm.conversationMessages("tab3").first { $0.role == .user }?.id
        XCTAssertNotNil(optimisticId, "Precondition: optimistic message must exist")

        // History replace (no echo yet) — optimistic survives.
        let serverMsgs = [assistantMessage(id: "srv-010")]
        vm.handleConversationHistory(tabId: "tab3", newMessages: serverMsgs, hasMore: false, cursor: nil)
        XCTAssertEqual(vm.conversationMessages("tab3").filter { $0.role == .user }.count, 1,
            "Precondition: optimistic must still be present after history replace")

        // Desktop echo arrives under the same clientMsgId — must reconcile.
        let echo = Message(id: optimisticId!, role: .user, content: "second message", timestamp: 1_700_000_001_000)
        vm.handleMessageAdded(tabId: "tab3", message: echo)

        let userMsgs = vm.conversationMessages("tab3").filter { $0.role == .user }
        XCTAssertEqual(userMsgs.count, 1,
            "Desktop echo must REPLACE the optimistic bubble by clientMsgId, not append a duplicate")
        XCTAssertEqual(userMsgs.first?.id, optimisticId,
            "The surviving bubble must carry the stable clientMsgId")
    }
}
