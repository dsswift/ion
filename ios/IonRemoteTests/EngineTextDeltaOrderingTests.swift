import XCTest
@testable import IonRemote

/// Regression tests for iOS assistant-row streaming boundaries.
///
/// History: the post-#256 "stalls after first turn" fix made handleEngineTextDelta
/// append a late delta to a SEALED assistant row (unsealing it), because the
/// desktop-side message_end/text_delta FIFO race let tail text arrive after the
/// seal. RC-12 supersedes that: Commit 2 fixed the race at the source
/// (flushKeyDeltas drains pending text BEFORE message_end on the wire), so text
/// is guaranteed to precede the seal. A delta that still arrives AFTER a sealed,
/// re-keyed canonical row is therefore a stray or the next turn — reopening the
/// canonical row corrupts its content (the fingerprint then diverges into a
/// reload loop) and can steal the re-key identity. The correct behavior is now:
/// a delta after a sealed row opens a FRESH assistant row; only an UNSEALED
/// trailing assistant row is appended to.
///
/// These tests pin the RC-12 behavior. See ConversationStalenessReconcileTests
/// testLateDeltaAfterSealDoesNotMutateSealedRow for the fingerprint-stability
/// companion.
@MainActor
final class EngineTextDeltaOrderingTests: XCTestCase {

    // MARK: - Helpers

    private func makeAssistant(content: String, sealed: Bool = false) -> Message {
        var m = Message(id: UUID().uuidString, role: .assistant, content: content,
                        timestamp: 1_700_000_000_000)
        m.sealed = sealed
        return m
    }

    private func makeTool(toolId: String) -> Message {
        Message(id: toolId, role: .tool, content: "", toolName: "Bash",
                toolId: toolId, toolStatus: .completed, timestamp: 1_700_000_000_001)
    }

    // MARK: - RC-12: a sealed row is NOT reopened by a late delta

    func testDeltaAfterSealOpensFreshRowNotReopenSealed() {
        // A sealed assistant row (message_end already finalized it). A late delta
        // must open a FRESH row, leaving the sealed row's content untouched.
        let vm = SessionViewModel()
        vm.mutateEngineInstance(tabId: "tab1", instanceId: nil) { inst in
            inst.messages = [self.makeAssistant(content: "partial", sealed: true)]
        }

        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: " tail")

        let msgs = vm.conversationMessages("tab1")
        XCTAssertEqual(msgs.count, 2, "a late delta after a sealed row opens a fresh row")
        XCTAssertEqual(msgs[0].content, "partial", "the sealed row's content must NOT be mutated")
        XCTAssertTrue(msgs[0].sealed, "the sealed row stays sealed")
        XCTAssertEqual(msgs[1].content, " tail")
        XCTAssertEqual(msgs[1].role, .assistant)
    }

    func testConsecutiveDeltasOnUnsealedRowAppendInPlace() {
        // The live (unsealed) row of the current run keeps appending in place.
        let vm = SessionViewModel()
        vm.mutateEngineInstance(tabId: "tab1", instanceId: nil) { inst in
            inst.messages = [self.makeAssistant(content: "text", sealed: false)]
        }

        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: " more")
        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: " content")

        let msgs = vm.conversationMessages("tab1")
        XCTAssertEqual(msgs.count, 1, "consecutive deltas on the unsealed live row append in place")
        XCTAssertEqual(msgs[0].content, "text more content")
        XCTAssertFalse(msgs[0].sealed)
    }

    func testDeltaAfterToolRowOpensNewAssistantRow() {
        // A tool row as the last message IS a new-turn signal — a fresh assistant
        // row must open (unchanged behavior).
        let vm = SessionViewModel()
        vm.mutateEngineInstance(tabId: "tab1", instanceId: nil) { inst in
            inst.messages = [
                self.makeAssistant(content: "turn 1 text", sealed: true),
                self.makeTool(toolId: "toolu_1"),
            ]
        }

        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: "turn 2 text")

        let msgs = vm.conversationMessages("tab1")
        XCTAssertEqual(msgs.count, 3, "After a tool row a new assistant row must open")
        XCTAssertEqual(msgs[2].role, .assistant)
        XCTAssertEqual(msgs[2].content, "turn 2 text")
    }

    func testMultipleDeltasExtendSingleRowWhenNoPriorMessage() {
        // Baseline: empty instance — first delta creates the assistant row,
        // subsequent deltas extend it (the row is unsealed while streaming).
        let vm = SessionViewModel()

        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: "Hello")
        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: " world")

        let msgs = vm.conversationMessages("tab1")
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs[0].content, "Hello world")
    }

    func testHandleEngineMessageEndSealsThenDeltaOpensFreshRow() {
        // Full integration: text → message_end (seal) → late delta. RC-12: the
        // late delta opens a fresh row rather than reopening the sealed canonical
        // one, so the sealed row's content (and its fingerprint) stays stable.
        let vm = SessionViewModel()

        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: "First part")
        vm.handleEngineMessageEnd(tabId: "tab1", instanceId: nil, inputTokens: 10, contextPercent: 0.1)

        let afterSeal = vm.conversationMessages("tab1")
        XCTAssertEqual(afterSeal.count, 1)
        XCTAssertTrue(afterSeal[0].sealed, "message_end must seal the assistant row")
        let sealedContent = afterSeal[0].content

        vm.handleEngineTextDelta(tabId: "tab1", instanceId: nil, text: " (late tail)")

        let final = vm.conversationMessages("tab1")
        XCTAssertEqual(final.count, 2, "a late delta after the seal opens a fresh row")
        XCTAssertEqual(final[0].content, sealedContent, "the sealed row's content is unchanged")
        XCTAssertEqual(final[1].content, " (late tail)")
    }
}
