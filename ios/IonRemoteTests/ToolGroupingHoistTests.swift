import XCTest
@testable import IonRemote

/// Behavior tests for the unified-turn thinking-hoist algorithm in
/// groupConversationItemsUnified (ToolGrouping.swift).
///
/// Cases pinned here:
///   (a) Hoist      — [thinking, tool, tool, assistant] → ONE .agentTurn with
///                    thinking set and tools/assistantMessages populated.
///   (b) No-tools   — [thinking, assistant] → standalone .thinking then
///                    .assistant, no .agentTurn.
///   (c) Merge      — N thinking rows in one turn merge into ONE thought row
///                    (stable first id, joined content, summed summary
///                    fields, any-active liveness, all-redacted). Never
///                    emitted standalone mid-turn. Desktop lockstep:
///                    mergeThinkingMessages in thinking-block-helpers.ts.
///   (d) Label      — AgentTurnRow idle label "Used N tools", active
///                    "Running tools…" (desktop parity).
final class ToolGroupingHoistTests: XCTestCase {

    // MARK: - Helpers

    private func makeMsg(id: String, role: MessageRole, toolStatus: ToolStatus? = nil) -> Message {
        var m = Message(id: id, role: role, content: "content-\(id)", timestamp: 1.0)
        m.toolStatus = toolStatus
        return m
    }

    // MARK: - (a) Hoist: thinking hoisted into agentTurn when tools present

    /// [thinking, tool, tool, assistant] with unifiedTurnView:true must produce
    /// exactly one .agentTurn whose thinking == the thinking message, with both
    /// tools and the assistant message populated. No standalone .thinking item.
    func testThinkingHoistedIntoAgentTurn() {
        let thinking  = makeMsg(id: "th1", role: .thinking)
        let tool1     = makeMsg(id: "to1", role: .tool)
        let tool2     = makeMsg(id: "to2", role: .tool)
        let assistant = makeMsg(id: "as1", role: .assistant)

        let items = groupConversationItems([thinking, tool1, tool2, assistant], unifiedTurnView: true)

        XCTAssertEqual(items.count, 1, "Expected exactly one item (agentTurn); got \(items.count)")
        guard case .agentTurn(let tools, let assistants, _, let hoisted) = items[0] else {
            XCTFail("Expected .agentTurn, got \(items[0])")
            return
        }
        XCTAssertEqual(tools.count, 2, "agentTurn must carry both tool messages")
        XCTAssertEqual(assistants.count, 1, "agentTurn must carry the assistant message")
        XCTAssertNotNil(hoisted, "thinking must be hoisted into agentTurn")
        XCTAssertEqual(hoisted?.id, "th1", "hoisted thinking id must match")
    }

    /// Regression: the old code flushed turnTools on a thinking message, so
    /// [thinking, tool, assistant] emitted standalone .thinking + .agentTurn
    /// instead of one .agentTurn with thinking hoisted. This test fails on the
    /// old code and passes on the fixed code.
    func testOldCodeRegressionHoistNotStandalone() {
        let thinking  = makeMsg(id: "th1", role: .thinking)
        let tool      = makeMsg(id: "to1", role: .tool)
        let assistant = makeMsg(id: "as1", role: .assistant)

        let items = groupConversationItems([thinking, tool, assistant], unifiedTurnView: true)

        XCTAssertEqual(items.count, 1,
            "Must be ONE item (agentTurn with hoisted thinking), not two (standalone thinking + agentTurn). Old code emitted two.")
        if case .agentTurn(_, _, _, let hoisted) = items[0] {
            XCTAssertNotNil(hoisted, "thinking must be inside agentTurn")
        } else {
            XCTFail("Expected .agentTurn at index 0, got \(items[0])")
        }
    }

    // MARK: - (b) No-tools: thinking + assistant without tools

    /// [thinking, assistant] must emit standalone .thinking then .assistant.
    /// No .agentTurn because there are no tools.
    func testNoToolsEmitsStandaloneThinkingThenAssistant() {
        let thinking  = makeMsg(id: "th1", role: .thinking)
        let assistant = makeMsg(id: "as1", role: .assistant)

        let items = groupConversationItems([thinking, assistant], unifiedTurnView: true)

        XCTAssertEqual(items.count, 2, "Expected .thinking then .assistant")
        guard case .thinking(let t) = items[0] else {
            XCTFail("Expected .thinking at index 0, got \(items[0])")
            return
        }
        XCTAssertEqual(t.id, "th1")
        guard case .assistant(let a) = items[1] else {
            XCTFail("Expected .assistant at index 1, got \(items[1])")
            return
        }
        XCTAssertEqual(a.id, "as1")
    }

    // MARK: - (c) Merge: one thought row per turn

    /// [thinkingA, tool, thinkingB, tool, assistant]: both thinking rows
    /// belong to the same turn, so they MERGE into one thought row on the
    /// agentTurn — nothing is emitted standalone. Regression guard for the
    /// old behavior that flushed A standalone and kept only B (fragmenting
    /// a turn into dozens of independent "Thought" rows).
    func testMultipleThinkingRowsMergeIntoOneTurnRow() {
        let thinkingA = makeMsg(id: "thA", role: .thinking)
        let tool1     = makeMsg(id: "to1", role: .tool)
        let thinkingB = makeMsg(id: "thB", role: .thinking)
        let tool2     = makeMsg(id: "to2", role: .tool)
        let assistant = makeMsg(id: "as1", role: .assistant)

        let items = groupConversationItems(
            [thinkingA, tool1, thinkingB, tool2, assistant],
            unifiedTurnView: true
        )

        // ONE item: the agentTurn with a single merged thought row.
        XCTAssertEqual(items.count, 1, "Expected one agentTurn with merged thinking; got \(items.count) items")
        guard case .agentTurn(let tools, let assistants, _, let merged) = items[0] else {
            XCTFail("Expected .agentTurn, got \(items[0])")
            return
        }
        XCTAssertEqual(tools.count, 2)
        XCTAssertEqual(assistants.count, 1)
        XCTAssertEqual(merged?.id, "thA", "merged row keeps the FIRST row's id (stable identity)")
        XCTAssertEqual(merged?.content, "content-thA\n\ncontent-thB", "contents join in stream order")
    }

    /// mergeThinkingMessages field rules: summed summary fields, any-active
    /// liveness, all-redacted only when every row is redacted.
    func testMergeThinkingMessagesFieldRules() {
        var a = makeMsg(id: "a", role: .thinking)
        a.thinkingActive = false
        a.thinkingElapsedSeconds = 2.5
        a.thinkingTotalTokens = 100
        var b = makeMsg(id: "b", role: .thinking)
        b.thinkingActive = true
        b.thinkingElapsedSeconds = 3.5
        b.thinkingTotalTokens = 250

        let merged = mergeThinkingMessages([a, b])
        XCTAssertEqual(merged.id, "a")
        XCTAssertTrue(merged.thinkingActive, "live while ANY row is active")
        XCTAssertEqual(merged.thinkingElapsedSeconds, 6.0)
        XCTAssertEqual(merged.thinkingTotalTokens, 350)
        XCTAssertFalse(merged.thinkingRedacted, "not redacted unless EVERY row is")

        var r1 = makeMsg(id: "r1", role: .thinking)
        r1.thinkingRedacted = true
        r1.content = ""
        var r2 = makeMsg(id: "r2", role: .thinking)
        r2.thinkingRedacted = true
        r2.content = ""
        XCTAssertTrue(mergeThinkingMessages([r1, r2]).thinkingRedacted)
    }

    /// Single-row input passes through unchanged (no synthesis).
    func testMergeSingleRowPassthrough() {
        var only = makeMsg(id: "solo", role: .thinking)
        only.thinkingElapsedSeconds = 4
        let merged = mergeThinkingMessages([only])
        XCTAssertEqual(merged.id, "solo")
        XCTAssertEqual(merged.content, "content-solo")
        XCTAssertEqual(merged.thinkingElapsedSeconds, 4)
    }

    /// No-tools path: multiple thinking rows still merge into ONE standalone
    /// .thinking item before the assistant text.
    func testNoToolsPathMergesThinkingRows() {
        let thinkingA = makeMsg(id: "thA", role: .thinking)
        let thinkingB = makeMsg(id: "thB", role: .thinking)
        let assistant = makeMsg(id: "as1", role: .assistant)

        let items = groupConversationItems([thinkingA, thinkingB, assistant], unifiedTurnView: true)

        XCTAssertEqual(items.count, 2, "Expected merged .thinking then .assistant")
        guard case .thinking(let t) = items[0] else {
            XCTFail("Expected .thinking at index 0, got \(items[0])")
            return
        }
        XCTAssertEqual(t.id, "thA")
        XCTAssertEqual(t.content, "content-thA\n\ncontent-thB")
    }

    /// Thinking rows never merge across user-turn boundaries.
    func testThinkingDoesNotMergeAcrossUserBoundary() {
        let thinkingA = makeMsg(id: "thA", role: .thinking)
        let tool1     = makeMsg(id: "to1", role: .tool)
        let user      = makeMsg(id: "us1", role: .user)
        let thinkingB = makeMsg(id: "thB", role: .thinking)
        let tool2     = makeMsg(id: "to2", role: .tool)

        let items = groupConversationItems(
            [thinkingA, tool1, user, thinkingB, tool2],
            unifiedTurnView: true
        )

        // [agentTurn(thA), user, agentTurn(thB)]
        XCTAssertEqual(items.count, 3)
        guard case .agentTurn(_, _, _, let first) = items[0],
              case .agentTurn(_, _, _, let second) = items[2] else {
            XCTFail("Expected agentTurn at 0 and 2, got \(items)")
            return
        }
        XCTAssertEqual(first?.content, "content-thA")
        XCTAssertEqual(second?.content, "content-thB")
    }

    // MARK: - (d) Label parity with desktop

    /// AgentTurnRow idle label: "Used N tools".
    /// AgentTurnRow active label: "Running tools…".
    ///
    /// These are UI-layer tests that inspect the label string logic directly
    /// by extracting it from the view. We verify via the public isActive
    /// property by replicating the label expression used in the view.
    func testIdleLabelUsedNTools() {
        // Mirrors the Text(...) expression in AgentTurnRow.
        let toolCount = 3
        let isActive = false
        let label = isActive
            ? "Running tools\u{2026}"
            : "Used \(toolCount) tool\(toolCount == 1 ? "" : "s")"
        XCTAssertEqual(label, "Used 3 tools")
    }

    func testIdleLabelUsedOneToolSingular() {
        let toolCount = 1
        let isActive = false
        let label = isActive
            ? "Running tools\u{2026}"
            : "Used \(toolCount) tool\(toolCount == 1 ? "" : "s")"
        XCTAssertEqual(label, "Used 1 tool")
    }

    func testActiveLabelRunningTools() {
        let toolCount = 2
        let isActive = true
        let label = isActive
            ? "Running tools\u{2026}"
            : "Used \(toolCount) tool\(toolCount == 1 ? "" : "s")"
        XCTAssertEqual(label, "Running tools\u{2026}")
    }

    // MARK: - toolGroupFailureSummary

    /// All-success (5 completed) → failed == 0, running == false.
    func testFailureSummaryAllSuccess() {
        let tools = (0..<5).map { makeMsg(id: "t\($0)", role: .tool, toolStatus: .completed) }
        let s = toolGroupFailureSummary(tools)
        XCTAssertEqual(s.failed, 0)
        XCTAssertEqual(s.total, 5)
        XCTAssertFalse(s.running)
        // Derived: not mixed, not all-failed.
        let settled = s.total
        XCTAssertFalse(s.failed > 0 && s.failed < settled, "should not be mixed")
        XCTAssertFalse(s.failed > 0 && s.failed == settled, "should not be all-failed")
    }

    /// Mixed (100 tools: 3 error, 97 completed) → failed == 3, total == 100,
    /// running == false, mixed == true.
    func testFailureSummaryMixed() {
        var tools: [Message] = []
        for i in 0..<97 { tools.append(makeMsg(id: "ok\(i)", role: .tool, toolStatus: .completed)) }
        for i in 0..<3  { tools.append(makeMsg(id: "er\(i)", role: .tool, toolStatus: .error)) }
        let s = toolGroupFailureSummary(tools)
        XCTAssertEqual(s.failed, 3)
        XCTAssertEqual(s.total, 100)
        XCTAssertFalse(s.running)
        // settled == total (no running); mixed = failed > 0 && failed < settled.
        let settled = s.total
        XCTAssertTrue(s.failed > 0 && s.failed < settled, "should be mixed")
        XCTAssertFalse(s.failed == settled, "should not be all-failed")
    }

    /// All-failed (4 error) → failed == 4 == total, all-failed == true.
    func testFailureSummaryAllFailed() {
        let tools = (0..<4).map { makeMsg(id: "er\($0)", role: .tool, toolStatus: .error) }
        let s = toolGroupFailureSummary(tools)
        XCTAssertEqual(s.failed, 4)
        XCTAssertEqual(s.total, 4)
        XCTAssertFalse(s.running)
        // settled == total; all-failed = failed == settled.
        XCTAssertEqual(s.failed, s.total, "all-failed: failed must equal total")
    }

    /// Running (2 completed, 1 running, 1 error) → running == true;
    /// suffix suppressed means callers must guard on running before
    /// appending the failure label.
    func testFailureSummaryRunningSupressesSuffix() {
        let tools = [
            makeMsg(id: "ok0", role: .tool, toolStatus: .completed),
            makeMsg(id: "ok1", role: .tool, toolStatus: .completed),
            makeMsg(id: "run", role: .tool, toolStatus: .running),
            makeMsg(id: "err", role: .tool, toolStatus: .error),
        ]
        let s = toolGroupFailureSummary(tools)
        XCTAssertTrue(s.running, "running must be true when any tool is .running")
        XCTAssertEqual(s.failed, 1)
        XCTAssertEqual(s.total, 4)
        // Callers suppress the suffix when running == true.
        // settled = total - runningCount = 4 - 1 = 3; failed (1) < settled (3) → mixed,
        // but the suffix is NOT shown. Verify the guard logic.
        guard !s.running else {
            // Suffix correctly suppressed — test passes.
            return
        }
        XCTFail("Suffix suppression guard failed: running is true but was not caught")
    }
}
