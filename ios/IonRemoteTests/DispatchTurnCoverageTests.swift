import XCTest
@testable import IonRemote

/// Turn-level coverage tests for the iOS live dispatched-agent transcript
/// merge (recomputeDispatchTranscript). Mirrors the desktop
/// agent-dispatch-activity.test.ts "turn-level coverage for incremental text
/// fragments" cases EXACTLY so desktop and iOS agree on the same vectors.
///
/// Background: the engine (dispatch_activity.go) emits each coalesced text
/// flush at a NEW monotonically increasing seq carrying only the INCREMENTAL
/// text since the previous flush — one push assistant entry per flush. Those
/// fragments concatenate, in materialized order, to exactly the single
/// finalized assistant message the file-backed snapshot persists for the turn.
///
/// The OLD merge deduped push text by exact string equality against the
/// snapshot, so the snapshot's single full message never matched any individual
/// fragment; all N fragments survived and rendered alongside the snapshot
/// message → the duplicated/repeating dispatched-sub-agent message bug.
///
/// The fix replaces exact equality with turn-level prefix coverage: concatenate
/// the push assistant entries' content (in materialized order) into
/// `pushTextRun`, drop ALL of them when some snapshot assistant message content
/// STARTS WITH `pushTextRun`, else keep them (genuinely newer in-flight
/// partial). Reverting the fix turns case (1) red (snapshot + 2 fragments = 3).
@MainActor
final class DispatchTurnCoverageTests: XCTestCase {

    private let convId = "child-conv-coverage"
    private let dispatchId = "dispatch-coverage-1"

    /// Case (1): snapshot = ONE finalized assistant message whose content ==
    /// concat of TWO push text fragments emitted at DISTINCT seqs (incremental,
    /// NOT coalesced in place). The merge must return the snapshot message ONCE
    /// with NO surviving fragment duplicates.
    ///
    /// BEFORE the fix (exact equality): snapshot + 2 fragments = 3 assistant
    /// entries → this assertion fails (revert-to-red).
    func testCoverage_dropsAllIncrementalFragmentsCoveredBySnapshot() {
        let vm = SessionViewModel()
        // Two fragments at DISTINCT seqs — each carries only the increment.
        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "text", seq: 1, ts: 10, toolName: nil, toolId: nil, textDelta: "Hello ", isError: false)
        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "text", seq: 2, ts: 20, toolName: nil, toolId: nil, textDelta: "world.", isError: false)

        // Snapshot has ONE finalized assistant message == concat of the fragments.
        let snapshot = [
            Message(id: "m1", role: .assistant, content: "Hello world.", timestamp: 1)
        ]
        vm.handleAgentConversationHistory(agentName: "dev", conversationId: convId, messages: snapshot)

        let merged = vm.agentConversationMessages[convId] ?? []
        let assistantEntries = merged.filter { $0.role == .assistant }
        XCTAssertEqual(assistantEntries.count, 1,
            "all incremental fragments must drop when the snapshot covers their concatenation (turn-level)")
        XCTAssertEqual(assistantEntries.first?.content, "Hello world.",
            "the snapshot's single finalized message must be the one retained")
    }

    func testStreamResetDropsUncommittedDispatchRows() {
        let vm = SessionViewModel()
        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "tool_start", seq: 1, ts: 10, toolName: "Read", toolId: "done", textDelta: nil, isError: false)
        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "tool_end", seq: 2, ts: 20, toolName: nil, toolId: "done", textDelta: nil, isError: false)
        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "text", seq: 3, ts: 30, toolName: nil, toolId: nil, textDelta: "partial", isError: false)
        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "tool_start", seq: 4, ts: 40, toolName: "Write", toolId: "partial", textDelta: nil, isError: false)

        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "stream_reset", seq: 5, resetAfterSeq: 2, ts: 50, toolName: nil, toolId: nil, textDelta: nil, isError: false)

        let messages = vm.agentConversationMessages[convId] ?? []
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.toolId, "done")
        XCTAssertEqual(messages.first?.toolStatus, .completed)
    }

    /// Case (2): in-flight run whose concatenation is NOT a prefix of any
    /// snapshot assistant message survives (no false drop). The snapshot has
    /// caught up only to an earlier turn; the live run is genuinely newer.
    func testCoverage_preservesInFlightRunNotCoveredBySnapshot() {
        let vm = SessionViewModel()
        let snapshot = [
            Message(id: "m1", role: .assistant, content: "Earlier finalized analysis.", timestamp: 1)
        ]
        vm.handleAgentConversationHistory(agentName: "dev", conversationId: convId, messages: snapshot)

        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "text", seq: 1, ts: 30, toolName: nil, toolId: nil, textDelta: "Now checking ", isError: false)
        vm.handleDispatchActivity(dispatchAgentId: dispatchId, conversationId: convId, kind: "text", seq: 2, ts: 40, toolName: nil, toolId: nil, textDelta: "file sizes.", isError: false)

        let merged = vm.agentConversationMessages[convId] ?? []
        let contents = merged.filter { $0.role == .assistant }.map { $0.content }
        // Snapshot message + both surviving fragments (the run is genuinely newer).
        XCTAssertEqual(contents, ["Earlier finalized analysis.", "Now checking ", "file sizes."],
            "an in-flight run not covered by any snapshot message must survive intact")
    }
}
