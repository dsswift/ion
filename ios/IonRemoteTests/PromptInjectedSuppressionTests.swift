import XCTest
@testable import IonRemote

/// engine_prompt_injected classification suppression (parity with the desktop
/// event-slice reducer).
///
/// An extension calling ctx.sendPrompt with the expanded body of a slash command
/// (ion-dev's /align, /implement, …) starts a run whose DISPLAY turn is the
/// command pill — the engine persists the raw invocation via
/// AddUserMessageWithInvocation. The injected body is redundant with that pill,
/// so the engine classifies the event kind="slash_command" and clients suppress
/// it. Without the guard, the multi-KB expanded template rendered as a second
/// user message (the /align wall-of-text regression).
///
/// The suppression lives in the `handleEvent` switch guard, so these tests drive
/// the full `RemoteEvent.enginePromptInjected` path, not `handleEnginePromptInjected`
/// directly. They go RED on unfixed code (the body appended as a user row) and
/// GREEN after the fix.
@MainActor
final class PromptInjectedSuppressionTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: .running,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    func testSlashCommandKindIsSuppressed() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        let expandedBody = String(repeating: "You are running the /align command. ", count: 500)
        vm.handleEvent(.enginePromptInjected(
            tabId: "t", instanceId: nil, prompt: expandedBody, origin: "ion-dev",
            kind: "slash_command", machineAuthored: true))
        XCTAssertTrue(vm.conversationMessages("t").isEmpty,
            "a slash_command-kind injection is the expanded command body — the display turn is the pill; it must not render as a user message")
    }

    func testAgentCompletionKindIsSuppressed() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEvent(.enginePromptInjected(
            tabId: "t", instanceId: nil, prompt: "child result body", origin: "ion-dev",
            kind: "agent_completion", machineAuthored: true))
        XCTAssertTrue(vm.conversationMessages("t").isEmpty,
            "agent_completion is a machine-to-machine dispatch callback and must not render as a user message")
    }

    func testEmptyKindRendersAsUserTurn() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEvent(.enginePromptInjected(
            tabId: "t", instanceId: nil, prompt: "please continue", origin: "ion-dev",
            kind: nil, machineAuthored: nil))
        let msgs = vm.conversationMessages("t")
        XCTAssertEqual(msgs.count, 1, "an unclassified extension injection is a genuine user turn and must render")
        XCTAssertEqual(msgs.first?.role, .user)
        XCTAssertEqual(msgs.first?.content, "please continue")
    }

    /// A check-in is machine authored and must NOT render.
    ///
    /// This is the reported defect at the iOS surface: a scheduled check-in
    /// delivered to an idle orchestrator appeared as a user message. It used to
    /// slip through because the guard matched three literal kind strings and
    /// "checkin" was not among them — the failure mode of a hand-maintained
    /// list. The verdict now comes from the engine's machineAuthored flag.
    func testCheckInKindIsSuppressed() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEvent(.enginePromptInjected(
            tabId: "t", instanceId: nil, prompt: "[SYSTEM] Dispatch check-in", origin: "ion-dev",
            kind: "checkin", machineAuthored: true))
        XCTAssertTrue(vm.conversationMessages("t").isEmpty,
            "a scheduled check-in is machine authored and must not render as a user message")
    }

    /// A kind this client has never heard of still suppresses when the engine
    /// says it is machine authored. This is the property that ends the
    /// recurrence: a kind added to the engine needs no edit here.
    func testUnknownMachineAuthoredKindIsSuppressed() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEvent(.enginePromptInjected(
            tabId: "t", instanceId: nil, prompt: "some future signal", origin: "ion-dev",
            kind: "some_future_kind", machineAuthored: true))
        XCTAssertTrue(vm.conversationMessages("t").isEmpty,
            "the engine flag is authoritative — an unrecognized machine kind must still be suppressed")
    }

    /// A legacy row carrying only the kind (no flag) still suppresses, so
    /// conversations persisted before machineAuthored existed do not suddenly
    /// show their dispatch callbacks.
    func testLegacyKindWithoutFlagIsSuppressed() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEvent(.enginePromptInjected(
            tabId: "t", instanceId: nil, prompt: "child result body", origin: "ion-dev",
            kind: "agent_completion", machineAuthored: nil))
        XCTAssertTrue(vm.conversationMessages("t").isEmpty,
            "a pre-flag agent_completion row must still be suppressed via the legacy kind fallback")
    }
}
