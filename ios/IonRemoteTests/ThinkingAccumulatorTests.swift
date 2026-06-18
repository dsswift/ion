import XCTest
@testable import IonRemote

/// Behavior tests for the extended-thinking accumulator (issue #158).
///
/// The accumulator (SessionViewModel+ThinkingEvents.swift) binds the three
/// desktop_thinking_* events into a single `.thinking` Message per reasoning
/// block. These tests pin the three documented render states and the
/// stream-reset semantics:
///
///   - block_start → live `.thinking` row (thinkingActive == true).
///   - deltas      → text appends to that live row, in order.
///   - block_end   → finalize: thinkingActive false + summary fields stamped.
///   - summary-only: block_start + block_end with NO deltas (the desktop's
///     low-bandwidth / streamThinkingToRemote-off path) leaves content empty
///     but still stamps the summary fields.
///   - redacted:     block_end with thinkingRedacted == true.
///   - stream reset: clearThinkingAccumulator drops the in-progress id so a
///     late delta after a history reload can't mutate the reloaded array.
///
/// The handlers write through `mutateEngineInstance`, which only mutates a
/// registered `ConversationInstanceInfo`. Each test seeds one instance under
/// a known (tabId, instanceId) first, matching how the snapshot/instance-added
/// path populates `conversationInstances` in production.
@MainActor
final class ThinkingAccumulatorTests: XCTestCase {

    private let tabId = "tab-1"
    private let instanceId = "inst-1"

    /// Build a SessionViewModel with a single registered engine instance so
    /// the accumulator's `mutateEngineInstance` writes land somewhere.
    private func makeViewModel() -> SessionViewModel {
        let vm = SessionViewModel()
        vm.conversationInstances[tabId] = [
            ConversationInstanceInfo(id: instanceId, label: "primary")
        ]
        vm.activeEngineInstance[tabId] = instanceId
        return vm
    }

    /// Read back the messages on the seeded instance.
    private func messages(_ vm: SessionViewModel) -> [Message] {
        vm.conversationInstances[tabId]?.first?.messages ?? []
    }

    private func thinkingMessages(_ vm: SessionViewModel) -> [Message] {
        messages(vm).filter { $0.role == .thinking }
    }

    // MARK: - Live → deltas → end

    /// The full happy path: block_start opens a live row, two deltas append
    /// their text in order, and block_end finalizes the row with the summary
    /// fields. This is the delta-streaming (non-low-bandwidth) case.
    func testBindsStartDeltasEnd() {
        let vm = makeViewModel()

        vm.handleEngineThinkingBlockStart(tabId: tabId, instanceId: instanceId)
        XCTAssertEqual(thinkingMessages(vm).count, 1, "block_start must append one live thinking row")
        XCTAssertTrue(thinkingMessages(vm)[0].thinkingActive, "row is live between start and end")
        XCTAssertEqual(thinkingMessages(vm)[0].content, "", "no deltas yet → empty content")

        vm.handleEngineThinkingDelta(tabId: tabId, instanceId: instanceId, thinkingText: "Let me ")
        vm.handleEngineThinkingDelta(tabId: tabId, instanceId: instanceId, thinkingText: "think.")
        XCTAssertEqual(thinkingMessages(vm)[0].content, "Let me think.", "deltas append in order")
        XCTAssertTrue(thinkingMessages(vm)[0].thinkingActive, "still live until block_end")

        vm.handleEngineThinkingBlockEnd(
            tabId: tabId, instanceId: instanceId,
            totalTokens: 412, elapsedSeconds: 14.5, redacted: false
        )
        let finalRows = thinkingMessages(vm)
        XCTAssertEqual(finalRows.count, 1, "block_end must NOT create a second row")
        XCTAssertFalse(finalRows[0].thinkingActive, "block_end clears the live flag")
        XCTAssertEqual(finalRows[0].content, "Let me think.", "text preserved through finalize")
        XCTAssertEqual(finalRows[0].thinkingTotalTokens, 412)
        XCTAssertEqual(finalRows[0].thinkingElapsedSeconds ?? 0, 14.5, accuracy: 0.001)
        XCTAssertFalse(finalRows[0].thinkingRedacted)

        // In-progress id forgotten so a stray late delta can't reopen it.
        XCTAssertNil(vm.thinkingInProgress[vm.resolveEngineKey(tabId: tabId, instanceId: instanceId)])
    }

    // MARK: - Summary-only (deltas absent)

    /// The low-bandwidth path: block_start + block_end with NO deltas (the
    /// desktop's streamThinkingToRemote toggle gated them off). The row still
    /// renders, but content stays empty and only the summary fields drive it.
    func testSummaryOnlyWhenDeltasAbsent() {
        let vm = makeViewModel()

        vm.handleEngineThinkingBlockStart(tabId: tabId, instanceId: instanceId)
        // No deltas arrive — straight to end.
        vm.handleEngineThinkingBlockEnd(
            tabId: tabId, instanceId: instanceId,
            totalTokens: 88, elapsedSeconds: 3.2, redacted: false
        )

        let rows = thinkingMessages(vm)
        XCTAssertEqual(rows.count, 1, "exactly one summary-only row")
        XCTAssertFalse(rows[0].thinkingActive)
        XCTAssertEqual(rows[0].content, "", "no deltas → empty content → summary-only render")
        XCTAssertEqual(rows[0].thinkingElapsedSeconds ?? 0, 3.2, accuracy: 0.001)
        XCTAssertEqual(rows[0].thinkingTotalTokens, 88)
    }

    /// Redacted (encrypted) reasoning: block_end with redacted == true. The
    /// row marks itself redacted so the view shows "🔒 redacted reasoning"
    /// rather than promising text.
    func testRedactedBlock() {
        let vm = makeViewModel()
        vm.handleEngineThinkingBlockStart(tabId: tabId, instanceId: instanceId)
        vm.handleEngineThinkingBlockEnd(
            tabId: tabId, instanceId: instanceId,
            totalTokens: nil, elapsedSeconds: nil, redacted: true
        )
        let rows = thinkingMessages(vm)
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].thinkingRedacted, "redacted flag must propagate to the row")
        XCTAssertEqual(rows[0].content, "")
    }

    // MARK: - Defensive / edge paths

    /// A delta with no in-progress block (arrives before block_start, or
    /// after block_end) is a no-op — the accumulator never synthesizes a row
    /// from a delta alone, so the boundary contract stays authoritative.
    func testStrayDeltaIsNoOp() {
        let vm = makeViewModel()
        vm.handleEngineThinkingDelta(tabId: tabId, instanceId: instanceId, thinkingText: "orphan")
        XCTAssertEqual(thinkingMessages(vm).count, 0, "delta without a live block creates nothing")
    }

    /// A second block_start while one is still open finalizes the orphan
    /// first, so the scrollback never shows two live thinking rows at once.
    func testOrphanedBlockFinalizedOnRestart() {
        let vm = makeViewModel()
        vm.handleEngineThinkingBlockStart(tabId: tabId, instanceId: instanceId)
        vm.handleEngineThinkingDelta(tabId: tabId, instanceId: instanceId, thinkingText: "first")
        // No block_end — a new block opens (e.g. transport dropped the end).
        vm.handleEngineThinkingBlockStart(tabId: tabId, instanceId: instanceId)

        let rows = thinkingMessages(vm)
        XCTAssertEqual(rows.count, 2, "two rows: the finalized orphan + the new live one")
        XCTAssertFalse(rows[0].thinkingActive, "orphan defensively finalized")
        XCTAssertTrue(rows[1].thinkingActive, "new block is live")
    }

    /// block_end with NO live block and NO summary is a no-op — a bare
    /// block_end the user can't act on never synthesizes an empty row.
    func testBareBlockEndWithoutStartIsNoOp() {
        let vm = makeViewModel()
        vm.handleEngineThinkingBlockEnd(
            tabId: tabId, instanceId: instanceId,
            totalTokens: nil, elapsedSeconds: nil, redacted: nil
        )
        XCTAssertEqual(thinkingMessages(vm).count, 0, "bare block_end with nothing to show creates nothing")
    }

    /// block_end with NO live block but WITH a summary (missing block_start,
    /// e.g. transport dropped it) still synthesizes a summary-only row so the
    /// user sees that reasoning happened.
    func testBlockEndWithoutStartButWithSummary() {
        let vm = makeViewModel()
        vm.handleEngineThinkingBlockEnd(
            tabId: tabId, instanceId: instanceId,
            totalTokens: 50, elapsedSeconds: 2.0, redacted: false
        )
        let rows = thinkingMessages(vm)
        XCTAssertEqual(rows.count, 1, "summary-bearing block_end recovers a row even without block_start")
        XCTAssertFalse(rows[0].thinkingActive)
        XCTAssertEqual(rows[0].thinkingTotalTokens, 50)
    }

    // MARK: - Stream reset

    /// Stream reset: after a history reload (clearThinkingAccumulator), a
    /// late delta for the now-stale block must NOT mutate the reloaded array.
    /// This is the iOS analogue of resetting an in-flight stream accumulator.
    func testClearAccumulatorDropsInProgressBlock() {
        let vm = makeViewModel()
        let key = vm.resolveEngineKey(tabId: tabId, instanceId: instanceId)

        vm.handleEngineThinkingBlockStart(tabId: tabId, instanceId: instanceId)
        XCTAssertNotNil(vm.thinkingInProgress[key], "block in progress after start")

        // Simulate a conversation-history reload wiping the accumulator.
        vm.clearThinkingAccumulator(forKey: key)
        XCTAssertNil(vm.thinkingInProgress[key], "accumulator cleared on stream reset")

        // A late delta must now be a no-op — content of the (still-present)
        // row must not change because the id binding is gone.
        let contentBefore = thinkingMessages(vm).first?.content
        vm.handleEngineThinkingDelta(tabId: tabId, instanceId: instanceId, thinkingText: "late chunk")
        let contentAfter = thinkingMessages(vm).first?.content
        XCTAssertEqual(contentBefore, contentAfter, "late delta after reset must not mutate the row")
    }
}
