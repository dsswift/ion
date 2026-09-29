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
        vm.submit(tabId: "eng", text: "hi")
        // #256 follow-up: the engine path no longer forks to a `.running`
        // optimistic status. The unified submit sets `.connecting` for EVERY
        // tab; the engine's own text/message events promote to `.running`.
        XCTAssertEqual(vm.tabs.first?.status, .connecting)
        // The pending bubble shows at once.
        XCTAssertEqual(vm.renderedMessages(tabId: "eng").last?.role, .user)
    }

    func testSubmitOnPlainTabUsesUnifiedConnectingStatus() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "plain", engine: false)]
        vm.submit(tabId: "plain", text: "hi")
        XCTAssertEqual(vm.tabs.first?.status, .connecting)
        XCTAssertEqual(vm.renderedMessages(tabId: "plain").last?.role, .user)
    }

    func testInputLockedTabRejectsSubmitWithoutOptimisticMessage() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "locked", engine: false)
        tab.inputLocked = true
        vm.tabs = [tab]

        vm.submit(tabId: "locked", text: "must not send")

        XCTAssertEqual(vm.tabs.first?.status, .idle)
        XCTAssertTrue(vm.renderedMessages(tabId: "locked").isEmpty)
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
        XCTAssertTrue(vm.renderedMessages(tabId: "settled").isEmpty)
    }

    /// There is no way to steer a compaction in progress, so submit() refuses
    /// the same way it refuses an input-locked tab — mirroring the desktop's
    /// promptRefusal('compacting'). The input bar disables Send for this too
    /// (ConversationView+InputBar.computeCannotSend); this pins the guard
    /// that covers every other entry point.
    func testCompactingTabRejectsSubmitWithoutOptimisticMessage() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "compacting", engine: false)
        tab.isCompacting = true
        vm.tabs = [tab]

        vm.submit(tabId: "compacting", text: "must not send")

        XCTAssertEqual(vm.tabs.first?.status, .idle)
        XCTAssertTrue(vm.renderedMessages(tabId: "compacting").isEmpty)
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
