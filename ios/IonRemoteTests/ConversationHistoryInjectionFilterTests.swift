import XCTest
@testable import IonRemote

/// Reload-side suppression of engine-injected turns (parity with the desktop's
/// `mapSessionHistory` filter in session-message-mapper.ts).
///
/// The live filter and the reload filter must agree. A kind suppressed live but
/// not on reload makes the transcript change shape the moment history
/// rehydrates — the machine-to-machine payload the user never saw during the
/// run reappears as a user bubble after a reconnect or tab switch.
///
/// Live-side coverage lives in PromptInjectedSuppressionTests; this class pins
/// the same decisions on the `handleConversationHistory` path.
@MainActor
final class ConversationHistoryInjectionFilterTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    /// A persisted injected turn. `machineAuthored` mirrors what the engine
    /// derives from the kind and writes onto the row (see
    /// types.InjectionKind.IsMachineToMachine); a fixture that omitted it would
    /// only exercise InjectionPolicy's legacy-kind fallback, which by design
    /// covers just the three pre-flag kinds.
    private func injected(
        id: String,
        content: String,
        kind: String?,
        ts: Double,
        machineAuthored: Bool? = nil
    ) -> Message {
        var m = Message(id: id, role: .user, content: content, timestamp: ts)
        m.injectionKind = kind
        m.machineAuthored = machineAuthored
        return m
    }

    /// A degraded ctx.steerSelf delivery persists TWO rows: the classified user
    /// turn and a steer marker beside it. The user turn is dropped; the marker
    /// row carries the divider. Net effect matches the live path exactly — one
    /// divider, zero user bubbles.
    func testDegradedSelfSteerTurnIsDroppedOnReload() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        var marker = Message(id: "m-marker", role: .system, content: "── Steer applied at 3:40 PM · 42 chars ──", timestamp: 2.5)
        marker.markerKind = "steer"
        marker.markerMessageLength = 42
        let history = [
            Message(id: "m1", role: .user, content: "kick off the work", timestamp: 1),
            injected(id: "m2", content: "[SYSTEM] Dispatch check-in", kind: "checkin", ts: 2, machineAuthored: true),
            marker,
            Message(id: "m3", role: .assistant, content: "checking dispatches", timestamp: 3),
        ]
        vm.handleConversationHistory(tabId: "t", newMessages: history, hasMore: false, cursor: nil)

        let msgs = vm.conversationMessages("t")
        XCTAssertEqual(msgs.count, 3, "reload keeps surrounding rows plus exactly one persisted steer divider")
        XCTAssertFalse(msgs.contains { $0.content.contains("Dispatch check-in") },
            "the check-in body reappeared on reload — live and reload disagree")
        let dividers = msgs.filter { $0.role == .system && $0.content.contains("Steer applied") }
        XCTAssertEqual(dividers.count, 1, "the persisted steer marker must survive reload as exactly one divider")
        XCTAssertEqual(dividers.first?.markerMessageLength, 42, "reload must retain persisted marker length")
    }

    func testAgentCompletionTurnIsDroppedOnReload() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        let history = [
            Message(id: "m1", role: .user, content: "start task", timestamp: 1),
            injected(id: "m2", content: "[Agent Dev Lead completed in 12s]", kind: "agent_completion", ts: 2),
        ]
        vm.handleConversationHistory(tabId: "t", newMessages: history, hasMore: false, cursor: nil)

        XCTAssertEqual(vm.conversationMessages("t").count, 1)
    }

    /// Guard against a filter that looks obviously right and is actively wrong.
    /// The engine never persists a slash command's EXPANDED body: it writes the
    /// raw invocation as the tree entry and sends the expansion only to the
    /// .llm.jsonl. So a reloaded row IS the pill the user typed, and suppressing
    /// it would delete their command from the transcript on every reload.
    func testSlashCommandPillSurvivesReload() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        var pill = Message(id: "m1", role: .user, content: "/align now", timestamp: 1)
        pill.slashCommand = "/align"

        vm.handleConversationHistory(tabId: "t", newMessages: [pill], hasMore: false, cursor: nil)

        let msgs = vm.conversationMessages("t")
        XCTAssertEqual(msgs.count, 1, "the slash-command pill is the user's own turn and must survive reload")
        XCTAssertEqual(msgs.first?.content, "/align now")
    }

    /// An unclassified injection (check-in, revive) is a genuine turn and stays.
    func testUnclassifiedInjectionSurvivesReload() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        let history = [injected(id: "m1", content: "please continue", kind: nil, ts: 1)]
        vm.handleConversationHistory(tabId: "t", newMessages: history, hasMore: false, cursor: nil)

        XCTAssertEqual(vm.conversationMessages("t").count, 1)
    }
}
