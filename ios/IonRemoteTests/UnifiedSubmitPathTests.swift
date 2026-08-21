import XCTest
@testable import IonRemote

/// Phase 5 of the #256 iOS unification, hardened by the #256 follow-up: one
/// submit / model / permission path with NO engine-vs-plain code fork.
///
/// `submit` and `setModel` are SINGLE branch-free paths: every conversation
/// tab — plain or extension-backed — flows through the identical code and
/// emits the identical wire command (`desktop_prompt` with an optional
/// `instanceId` data field; `desktop_set_tab_model`). The only per-tab
/// difference is DATA, never a branch on tab type. `PendingCard.restoredCard`
/// is the shared restored-special-card synthesis used by both tab types so
/// plan/ask cards survive a history reload identically.
@MainActor
final class UnifiedSubmitPathTests: XCTestCase {

    private func makeTab(id: String, engine: Bool) -> RemoteTabState {
        RemoteTabState(
            id: id,
            title: id,
            customTitle: nil,
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: [],
            hasEngineExtension: engine
        )
    }

    private func toolMessage(id: String, toolName: String, toolInput: String) -> Message {
        // role == .tool makes `isTool` (a computed property) true.
        var m = Message(id: id, role: .tool, content: "", timestamp: 1)
        m.toolName = toolName
        m.toolInput = toolInput
        return m
    }

    /// Source of the unified submit/setModel file. The single-path contract is
    /// pinned at the declaration site (the forks were source-level branches).
    private func submitSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/ViewModels/SessionViewModel+Submit.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - submit: single unified path, identical optimistic behavior

    func testSubmitOnEngineTabUsesUnifiedConnectingStatus() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "eng", engine: true)]
        vm.conversationLoaded.insert("eng")
        vm.submit(tabId: "eng", text: "hi")
        // #256 follow-up: the engine path no longer forks to a `.running`
        // optimistic status. The unified submit sets `.connecting` for EVERY
        // tab; the engine's own text/message events promote to `.running`.
        XCTAssertEqual(vm.tabs.first?.status, .connecting)
        // The optimistic user message landed on the unified store.
        XCTAssertEqual(vm.conversationMessages("eng").last?.role, .user)
    }

    func testSubmitOnPlainTabUsesUnifiedConnectingStatus() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "plain", engine: false)]
        vm.conversationLoaded.insert("plain")
        vm.submit(tabId: "plain", text: "hi")
        XCTAssertEqual(vm.tabs.first?.status, .connecting)
        XCTAssertEqual(vm.conversationMessages("plain").last?.role, .user)
    }

    func testInputLockedTabRejectsSubmitWithoutOptimisticMessage() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "locked", engine: false)
        tab.inputLocked = true
        vm.tabs = [tab]

        vm.submit(tabId: "locked", text: "must not send")

        XCTAssertEqual(vm.tabs.first?.status, .idle)
        XCTAssertTrue(vm.conversationMessages("locked").isEmpty)
    }

    /// Settled conversations are input-locked with reason "settled". The
    /// submit guard must block them identically to other lock reasons.
    func testSettledLockedTabRejectsSubmit() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "settled", engine: false)
        tab.inputLocked = true
        tab.inputLockReason = "settled"
        vm.tabs = [tab]

        vm.submit(tabId: "settled", text: "must not send")

        XCTAssertEqual(vm.tabs.first?.status, .idle,
            "settled lock must block submit identically to other lock reasons")
        XCTAssertTrue(vm.conversationMessages("settled").isEmpty)
    }

    /// The DATA seam: an extension-backed tab carries an `instanceId`, a plain
    /// tab does not. This is the only per-tab difference in the submit path.
    func testResolveSubmitInstanceIdIsTheOnlyPerTabDifference() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "eng", engine: true), makeTab(id: "plain", engine: false)]
        vm.conversationInstances["eng"] = [ConversationInstanceInfo(id: "main", label: "Main")]
        vm.activeEngineInstance["eng"] = "main"
        XCTAssertEqual(vm.resolveSubmitInstanceId(tabId: "eng"), "main",
            "An extension-backed tab carries its active conversation-instance id on the wire")
        XCTAssertNil(vm.resolveSubmitInstanceId(tabId: "plain"),
            "A plain CLI tab carries NO instanceId — the data-field absence is what routes it to the CLI pipeline")
    }

    // MARK: - setModel: single unified wire command for both tab types

    /// Source-level guard: `submit` and `setModel` must be SINGLE branch-free
    /// paths. Pre-#256-follow-up they forked on
    /// `tabs.first(...)?.hasEngineExtension == true` to dispatch to distinct
    /// engine-vs-plain methods (`submitEnginePrompt`/`sendPrompt`,
    /// `setEngineModel`/`setTabModel`) emitting different wire commands. This
    /// pins that the fork is gone and that each path emits exactly one wire
    /// command. (SwiftUI/transport aren't introspectable in a unit test; the
    /// declaration site is the contract, mirroring the merged-view guards.)
    func testSubmitAndSetModelAreSingleBranchFreePaths() throws {
        let src = try submitSource()
        // The illegitimate tab-type dispatch forks must NOT exist.
        XCTAssertFalse(src.contains("submitEnginePrompt(tabId:"),
            "submit must not dispatch to a separate engine path — single unified path (#256 follow-up)")
        XCTAssertFalse(src.contains("setEngineModel(tabId:"),
            "setModel must not dispatch to a separate engine path — single unified path (#256 follow-up)")
        XCTAssertFalse(src.contains("if isEngine {"),
            "No engine-vs-plain branch may remain in submit/setModel")
        // setModel emits exactly the unified wire command, once.
        let setTabModelSends = src.components(separatedBy: "send(.setTabModel(").count - 1
        XCTAssertEqual(setTabModelSends, 1,
            "setModel must emit `desktop_set_tab_model` exactly once, for every tab type")
        XCTAssertFalse(src.contains("send(.engineSetModel("),
            "setModel must not emit the engine-only set-model command — it was collapsed into desktop_set_tab_model")
        // submit emits exactly the unified prompt command, once.
        let promptSends = src.components(separatedBy: "send(.prompt(").count - 1
        XCTAssertEqual(promptSends, 1,
            "submit must emit `desktop_prompt` exactly once, for every tab type")
    }

    func testSetModelEmitsSameWireCommandForBothTabTypes() throws {
        // The single setModel path emits `desktop_set_tab_model` regardless of
        // tab type — pin the wire command name is identical for both. We capture
        // the encoded command shape (no transport is wired in a unit test); the
        // command the VM constructs is the contract.
        let encoder = JSONEncoder()
        let engineCmd = RemoteCommand.setTabModel(tabId: "eng", model: "m")
        let plainCmd = RemoteCommand.setTabModel(tabId: "plain", model: "m")
        let engineType = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoder.encode(engineCmd)) as? [String: Any])["type"] as? String
        let plainType = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoder.encode(plainCmd)) as? [String: Any])["type"] as? String
        XCTAssertEqual(engineType, "desktop_set_tab_model")
        XCTAssertEqual(plainType, "desktop_set_tab_model")
        XCTAssertEqual(engineType, plainType,
            "setModel must emit the SAME wire command for every tab type — no engine-vs-plain fork")
    }

    func testSetModelOnEngineTabWritesInstanceOverride() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "eng", engine: true)]
        vm.conversationInstances["eng"] = [ConversationInstanceInfo(id: "main", label: "Main")]
        vm.activeEngineInstance["eng"] = "main"
        vm.setModel(tabId: "eng", model: "claude-opus-4-7")
        XCTAssertEqual(vm.conversationInstances["eng"]?.first?.modelOverride, "claude-opus-4-7",
            "The unified setModel writes the override onto the tab's single conversation instance")
    }

    func testSetModelOnPlainTabWritesTabOverride() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "plain", engine: false)]
        vm.setModel(tabId: "plain", model: "claude-opus-4-7")
        // The unified path mirrors the override onto the tab-level field for
        // the plain reader path (preserving the prior optimistic-UI contract).
        XCTAssertEqual(vm.tabs.first?.modelOverride, "claude-opus-4-7")
    }

    // MARK: - Restored-card synthesis parity

    func testRestoredCardSynthesizedFromHistoryForBothTabTypes() {
        // The synthesis is pure over messages, so a plan card restores
        // identically regardless of tab type.
        let msgs = [
            Message(id: "u1", role: .user, content: "do it", timestamp: 1),
            toolMessage(id: "t1", toolName: "ExitPlanMode", toolInput: "{\"plan\":\"the plan\"}"),
        ]
        let card = PendingCard.restoredCard(for: msgs)
        XCTAssertNotNil(card)
        XCTAssertEqual(card?.questionId, "restored-t1")
        XCTAssertEqual(card?.toolName, "ExitPlanMode")
        XCTAssertNotNil(card?.toolInput?["plan"])
    }

    func testRestoredCardSuppressedByTrailingUserMessage() {
        let msgs = [
            toolMessage(id: "t1", toolName: "AskUserQuestion", toolInput: "{}"),
            Message(id: "u2", role: .user, content: "answered", timestamp: 2),
        ]
        XCTAssertNil(PendingCard.restoredCard(for: msgs),
            "A user message after the tool dismisses the restored card")
    }

    func testRestoredCardNilWhenLastToolIsNotSpecial() {
        let msgs = [toolMessage(id: "t1", toolName: "Bash", toolInput: "{}")]
        XCTAssertNil(PendingCard.restoredCard(for: msgs))
    }

    // MARK: - Outgoing message reconciliation (no duplicate user bubble)

    /// Regression for the iOS Remote outgoing-duplication bug. The optimistic
    /// user bubble is inserted under a stable id; the desktop echoes the user
    /// message back under that SAME id (`clientMsgId`). handleMessageAdded must
    /// reconcile by id and REPLACE in place, leaving exactly ONE user message.
    /// Before the fix the optimistic insert used a throwaway UUID the echo could
    /// never match, so the echo appended a second user bubble. Revert the fix
    /// (optimistic id back to a fresh UUID, or drop clientMsgId on the wire) and
    /// this goes RED with two user messages.
    func testEngineTabUserEchoReconcilesByIdNoDuplicate() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "eng", engine: true)]
        vm.conversationInstances["eng"] = [ConversationInstanceInfo(id: "main", label: "Main")]
        vm.activeEngineInstance["eng"] = "main"
        vm.conversationLoaded.insert("eng")

        vm.submit(tabId: "eng", text: "do the thing")

        // The optimistic bubble's id IS the clientMsgId sent on the wire.
        let optimisticId = vm.conversationMessages("eng").last { $0.role == .user }?.id
        XCTAssertNotNil(optimisticId)

        // Simulate the desktop echo arriving under the same id.
        let echo = Message(id: optimisticId!, role: .user, content: "do the thing", timestamp: 2)
        vm.handleMessageAdded(tabId: "eng", message: echo)

        let userMsgs = vm.conversationMessages("eng").filter { $0.role == .user }
        XCTAssertEqual(userMsgs.count, 1,
            "The desktop echo must REPLACE the optimistic bubble by id, not append a duplicate")
    }

    func testPlainTabUserEchoReconcilesByIdNoDuplicate() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "plain", engine: false)]
        vm.conversationLoaded.insert("plain")

        vm.submit(tabId: "plain", text: "hello")
        let optimisticId = vm.conversationMessages("plain").last { $0.role == .user }?.id
        XCTAssertNotNil(optimisticId)

        let echo = Message(id: optimisticId!, role: .user, content: "hello", timestamp: 2)
        vm.handleMessageAdded(tabId: "plain", message: echo)

        let userMsgs = vm.conversationMessages("plain").filter { $0.role == .user }
        XCTAssertEqual(userMsgs.count, 1,
            "CLI echo (id = clientMsgId) must replace the optimistic bubble, not append a duplicate")
    }

    /// The optimistic id and the wire `clientMsgId` must be the SAME value. We
    /// can't introspect the transport in a unit test, but we can pin that the
    /// submit source uses one generated id for both the optimistic Message and
    /// the `.prompt` send, never a fresh UUID for the message.
    func testSubmitSourceUsesSharedClientMsgIdForOptimisticAndWire() throws {
        let src = try submitSource()
        XCTAssertTrue(src.contains("let clientMsgId = UUID().uuidString"),
            "submit must generate one stable clientMsgId")
        XCTAssertTrue(src.contains("id: clientMsgId"),
            "the optimistic Message must use clientMsgId as its id")
        XCTAssertTrue(src.contains("clientMsgId: clientMsgId"),
            "the .prompt wire command must carry the same clientMsgId")
        XCTAssertFalse(src.contains("id: UUID().uuidString,\n                role: .user"),
            "the optimistic user Message must NOT use a throwaway UUID id")
    }
}
