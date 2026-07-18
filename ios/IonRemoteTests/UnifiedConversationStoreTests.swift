import XCTest
@testable import IonRemote

/// Phase 1 of the #256 iOS unification: the single per-tab conversation store.
///
/// These tests pin the unified accessors in SessionViewModel+Conversation.swift
/// — `conversationMessages`, `mutateConversationMessages`, `liveText`,
/// `setLiveText`, `ensureMainInstance` — and the central parity contract: a
/// **plain** tab (engineProfileId == nil) and an **engine** tab
/// (engineProfileId set) drive the *same* store through the *same* accessors.
///
/// Before this phase plain tabs lived in loose top-level dicts (`messages[tabId]`,
/// `liveText[tabId]`) while engine tabs used `conversationInstances[tabId][]`.
/// The whole point of the unification is that there is now one store; these
/// tests fail on the pre-phase code because the accessors did not exist and the
/// two tab types wrote to different places.
@MainActor
final class UnifiedConversationStoreTests: XCTestCase {

    private func makeMessage(id: String, role: MessageRole, content: String) -> Message {
        Message(id: id, role: role, content: content, timestamp: 1_700_000_000_000)
    }

    // MARK: - ensureMainInstance

    func testEnsureMainInstanceCreatesSingleInstance() {
        let vm = SessionViewModel()
        XCTAssertNil(vm.conversationInstances["tab-1"])

        let id = vm.ensureMainInstance(tabId: "tab-1")

        XCTAssertEqual(id, ConversationInstanceInfo.mainInstanceId)
        XCTAssertEqual(vm.conversationInstances["tab-1"]?.count, 1)
        XCTAssertEqual(vm.activeEngineInstance["tab-1"], ConversationInstanceInfo.mainInstanceId)
    }

    func testEnsureMainInstanceIsIdempotentAndPreservesState() {
        let vm = SessionViewModel()
        vm.mutateConversationMessages(tabId: "tab-1") {
            $0.append(self.makeMessage(id: "m1", role: .user, content: "hello"))
        }
        // A second ensure must not wipe the existing instance/messages.
        let id = vm.ensureMainInstance(tabId: "tab-1")
        XCTAssertEqual(id, ConversationInstanceInfo.mainInstanceId)
        XCTAssertEqual(vm.conversationInstances["tab-1"]?.count, 1)
        XCTAssertEqual(vm.conversationMessages("tab-1").count, 1)
        XCTAssertEqual(vm.conversationMessages("tab-1").first?.content, "hello")
    }

    func testEnsureMainInstancePreservesExistingEngineInstanceId() {
        // An engine tab whose instance arrived from a snapshot keeps its id;
        // ensureMainInstance must not overwrite it.
        let vm = SessionViewModel()
        vm.conversationInstances["tab-e"] = [ConversationInstanceInfo(id: "main", label: "Main")]
        let id = vm.ensureMainInstance(tabId: "tab-e")
        XCTAssertEqual(id, "main")
        XCTAssertEqual(vm.activeEngineInstance["tab-e"], "main")
    }

    // MARK: - Parity: messages

    func testPlainAndEngineTabsShareTheSameMessageStore() {
        let vm = SessionViewModel()

        // Plain tab message_added path lands on the single instance.
        vm.conversationLoaded.insert("plain")
        vm.handleMessageAdded(tabId: "plain", message: makeMessage(id: "p1", role: .assistant, content: "plain reply"))

        // Engine tab text_delta path lands on the single instance.
        vm.handleEngineTextDelta(tabId: "engine", instanceId: nil, text: "engine reply")

        // Both readable through the same accessor.
        XCTAssertEqual(vm.conversationMessages("plain").count, 1)
        XCTAssertEqual(vm.conversationMessages("plain").first?.content, "plain reply")
        XCTAssertEqual(vm.conversationMessages("engine").count, 1)
        XCTAssertEqual(vm.conversationMessages("engine").first?.content, "engine reply")

        // Both stored as the single `main`-style instance.
        XCTAssertEqual(vm.conversationInstances["plain"]?.count, 1)
        XCTAssertEqual(vm.conversationInstances["engine"]?.count, 1)
    }

    func testConversationInstancesStayInSyncAcrossBothWriters() {
        let vm = SessionViewModel()

        vm.conversationLoaded.insert("plain")
        vm.handleMessageAdded(tabId: "plain", message: makeMessage(id: "p1", role: .user, content: "q"))
        XCTAssertEqual(vm.conversationInstances["plain"]?.first?.messages.count, 1)

        // Engine text-delta writer goes through mutateEngineInstance.
        vm.handleEngineTextDelta(tabId: "engine", instanceId: nil, text: "a")
        XCTAssertEqual(vm.conversationInstances["engine"]?.first?.messages.count, 1)
    }

    // MARK: - Incoming-duplication regression (engine stream is single-path)

    /// The engine stream reaches iOS via the structured path only
    /// (desktop_text_delta → handleEngineTextDelta, desktop_tool_start →
    /// handleEngineToolStart). The desktop must NOT also mirror those as
    /// desktop_message_added/updated (the sessionPlane duplicate that this
    /// branch's Fix B removes). This test pins the iOS consumer's single-row
    /// behavior: multiple text deltas extend ONE assistant row, and a tool
    /// start adds ONE tool row keyed by toolId.
    func testEngineStreamProducesSingleAssistantAndToolRows() {
        let vm = SessionViewModel()
        vm.conversationLoaded.insert("engine")

        // Streaming assistant text: two deltas extend one row (last row is an
        // unsealed assistant message).
        vm.handleEngineTextDelta(tabId: "engine", instanceId: nil, text: "Hello")
        vm.handleEngineTextDelta(tabId: "engine", instanceId: nil, text: " world")

        let assistantRows = vm.conversationMessages("engine").filter { $0.role == .assistant }
        XCTAssertEqual(assistantRows.count, 1, "Text deltas extend a single assistant row")
        XCTAssertEqual(assistantRows.first?.content, "Hello world")

        // Tool start adds one tool row.
        vm.handleEngineToolStart(tabId: "engine", instanceId: nil, toolName: "Bash", toolId: "toolu_1")
        let toolRows = vm.conversationMessages("engine").filter { $0.role == .tool }
        XCTAssertEqual(toolRows.count, 1, "A tool start adds exactly one tool row")
        XCTAssertEqual(toolRows.first?.toolId, "toolu_1")
    }

    /// Demonstrates WHY the desktop-side suppression is required: if the desktop
    /// ALSO sent a desktop_message_added(tool) with the same toolId (the removed
    /// sessionPlane duplicate), iOS would append a SECOND tool row because
    /// handleEngineToolStart appends unconditionally and handleMessageAdded only
    /// reconciles by id when the id already exists. Order matters — the real bug
    /// had messageAdded arrive first, then engineToolStart append a duplicate.
    func testDuplicateToolEnvelopesWouldDoubleRowsConfirmingSuppressionMatters() {
        let vm = SessionViewModel()
        vm.conversationLoaded.insert("engine")

        // Simulate double-path delivery: sessionPlane message_added(tool) first,
        // then the structured engine_tool_start for the same toolId.
        vm.handleMessageAdded(tabId: "engine", message: {
            var m = Message(id: "toolu_1", role: .tool, content: "", timestamp: 1)
            m.toolName = "Bash"
            m.toolId = "toolu_1"
            m.toolStatus = .running
            return m
        }())
        vm.handleEngineToolStart(tabId: "engine", instanceId: nil, toolName: "Bash", toolId: "toolu_1")

        let toolRows = vm.conversationMessages("engine").filter { $0.role == .tool }
        // RC-22: handleEngineToolStart now guards against a duplicate toolId and
        // refreshes the existing row in place instead of appending a second. So
        // even if both paths deliver the tool row, iOS yields exactly ONE — the
        // desktop suppression is still correct, but iOS is now resilient to it.
        XCTAssertEqual(toolRows.count, 1,
            "RC-22: a duplicate tool envelope for the same toolId must not double the row")
    }

    func testHistoryLoadReplacesMessagesForBothTabTypes() {
        let vm = SessionViewModel()
        let history = [
            makeMessage(id: "h1", role: .user, content: "first"),
            makeMessage(id: "h2", role: .assistant, content: "second"),
        ]
        vm.handleConversationHistory(tabId: "plain", newMessages: history, hasMore: false, cursor: nil)
        XCTAssertEqual(vm.conversationMessages("plain").count, 2)
        XCTAssertTrue(vm.conversationLoaded.contains("plain"))
    }

    // MARK: - Parity: live text

    func testLiveTextAccessorBacksBothTabTypes() {
        let vm = SessionViewModel()

        vm.appendLiveText(tabId: "plain", "streaming…")
        vm.appendLiveText(tabId: "engine", "engine streaming…")

        XCTAssertEqual(vm.liveText("plain"), "streaming…")
        XCTAssertEqual(vm.liveText("engine"), "engine streaming…")

        vm.clearLiveText(tabId: "plain")
        XCTAssertEqual(vm.liveText("plain"), "")
        // Clearing one tab does not affect another.
        XCTAssertEqual(vm.liveText("engine"), "engine streaming…")
    }

    func testLiveTextIsSeparateFromMessages() {
        // Live text and messages are distinct fields on the same instance —
        // appending live text must not create a message and vice-versa.
        let vm = SessionViewModel()
        vm.appendLiveText(tabId: "tab-1", "partial")
        XCTAssertEqual(vm.conversationMessages("tab-1").count, 0)
        XCTAssertEqual(vm.liveText("tab-1"), "partial")

        vm.mutateConversationMessages(tabId: "tab-1") {
            $0.append(self.makeMessage(id: "m1", role: .assistant, content: "done"))
        }
        XCTAssertEqual(vm.conversationMessages("tab-1").count, 1)
        XCTAssertEqual(vm.liveText("tab-1"), "partial")
    }

    // MARK: - Parity: thinking accumulator (Phase 2)

    func testThinkingBlockFinalizesOnTheSingleInstanceForBothTabTypes() {
        // The thinking accumulator id now lives on the single instance
        // (thinkingMessageId) rather than a top-level compound-keyed dict, so a
        // plain tab and an engine tab drive the same lifecycle identically.
        for tabId in ["plain", "engine"] {
            let vm = SessionViewModel()
            vm.handleEngineThinkingBlockStart(tabId: tabId, instanceId: nil)
            XCTAssertNotNil(vm.thinkingMessageId(tabId), "\(tabId): block in progress")

            vm.handleEngineThinkingDelta(tabId: tabId, instanceId: nil, thinkingText: "reasoning…")
            vm.handleEngineThinkingBlockEnd(tabId: tabId, instanceId: nil, totalTokens: 12, elapsedSeconds: 1.5, redacted: false)

            // Exactly one finalized .thinking message; accumulator cleared.
            let thinking = vm.conversationMessages(tabId).filter { $0.role == .thinking }
            XCTAssertEqual(thinking.count, 1, "\(tabId): one thinking row")
            XCTAssertEqual(thinking.first?.thinkingActive, false, "\(tabId): finalized")
            XCTAssertEqual(thinking.first?.content, "reasoning…")
            XCTAssertNil(vm.thinkingMessageId(tabId), "\(tabId): accumulator cleared")
        }
    }
}
