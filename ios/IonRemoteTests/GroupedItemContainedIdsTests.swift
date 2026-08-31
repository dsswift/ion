import XCTest
@testable import IonRemote

/// `GroupedItem.containedMessageIds` — the message-id → row translation a
/// transcript jump depends on.
///
/// THE BUG THIS EXISTS FOR: the collection view's data source is keyed by GROUP
/// identity (`at-<anchor>` for a unified turn, `tg-<anchor>` for a tool group),
/// so a member message has no row of its own. A chart's tool row lives inside a
/// unified turn, and the attachments panel jumps to that tool row's message id.
/// The lookup asked the data source for a row with that id, found nothing, and
/// the tap did nothing — while every log line upstream reported success,
/// because the row id it resolved was genuinely correct.
///
/// The desktop hit the same wall and generalized its lookup from "the row with
/// this id" to "the row that CONTAINS this id" (`findRowIndexForMessage`).
/// These tests pin the iOS equivalent.
final class GroupedItemContainedIdsTests: XCTestCase {

    private func msg(id: String, role: MessageRole, content: String = "x") -> Message {
        Message(id: id, role: role, content: content, timestamp: 1_000)
    }

    private func tool(id: String) -> Message {
        var message = msg(id: id, role: .tool)
        message.toolName = "RenderChart"
        message.toolStatus = ToolStatus.completed
        return message
    }

    // MARK: - Unified turns

    func testAgentTurnContainsEveryToolRow() {
        // The case that broke: a chart's tool row is a MEMBER of the turn, and
        // the turn's own id is derived from the FIRST tool — so a chart on any
        // later tool row was unreachable.
        let tools = [tool(id: "call_a"), tool(id: "call_b"), tool(id: "call_c")]
        let item = ConversationView.GroupedItem.agentTurn(
            tools: tools,
            assistantMessages: [],
            isActive: false,
            thinking: nil
        )

        XCTAssertTrue(item.containedMessageIds.contains("call_a"))
        XCTAssertTrue(item.containedMessageIds.contains("call_b"),
                      "a chart on a later tool row must still resolve to this turn")
        XCTAssertTrue(item.containedMessageIds.contains("call_c"))
    }

    func testAgentTurnRowIdIsNotAMessageId() {
        // This is precisely why the direct lookup failed: the row's identity is
        // a prefixed group key, never the member's id.
        let tools = [tool(id: "call_a")]
        let item = ConversationView.GroupedItem.agentTurn(
            tools: tools, assistantMessages: [], isActive: false, thinking: nil
        )
        XCTAssertNotEqual(item.id, "call_a")
        XCTAssertTrue(item.containedMessageIds.contains("call_a"))
    }

    func testAgentTurnContainsAssistantsAndThinking() {
        let item = ConversationView.GroupedItem.agentTurn(
            tools: [tool(id: "call_a")],
            assistantMessages: [msg(id: "asst_1", role: .assistant)],
            isActive: false,
            thinking: msg(id: "think_1", role: .assistant)
        )

        XCTAssertTrue(item.containedMessageIds.contains("asst_1"))
        XCTAssertTrue(item.containedMessageIds.contains("think_1"))
    }

    // MARK: - Other row kinds

    func testToolGroupContainsEveryTool() {
        let tools = [tool(id: "call_a"), tool(id: "call_b")]
        let item = ConversationView.GroupedItem.toolGroup(tools)

        XCTAssertEqual(item.containedMessageIds, ["call_a", "call_b"])
        XCTAssertNotEqual(item.id, "call_a", "tool groups also key on a prefix")
    }

    func testSingleRowContainsItsOwnMessage() {
        // A plain message IS its own row, so containment and identity agree.
        let message = msg(id: "m1", role: .assistant)
        let item = ConversationView.GroupedItem.single(message, followsUser: false)

        XCTAssertEqual(item.containedMessageIds, ["m1"])
        XCTAssertEqual(item.id, "m1")
    }

    func testCompactionAndThinkingRowsContainTheirMessage() {
        let compaction = ConversationView.GroupedItem.compaction(msg(id: "c1", role: .system))
        let thinking = ConversationView.GroupedItem.thinking(msg(id: "t1", role: .assistant))

        XCTAssertEqual(compaction.containedMessageIds, ["c1"])
        XCTAssertEqual(thinking.containedMessageIds, ["t1"])
        // Both key on a prefix, so both need containment to be reachable.
        XCTAssertNotEqual(compaction.id, "c1")
        XCTAssertNotEqual(thinking.id, "t1")
    }

    // MARK: - Resolution

    func testExactlyOneRowClaimsAGivenMessage() {
        // The transcript scans rows and takes the first that claims the id; two
        // claimants would make the jump target ambiguous.
        let rows: [ConversationView.GroupedItem] = [
            .single(msg(id: "m1", role: .user), followsUser: false),
            .agentTurn(tools: [tool(id: "call_a")], assistantMessages: [], isActive: false, thinking: nil),
            .toolGroup([tool(id: "call_b")]),
        ]

        for target in ["m1", "call_a", "call_b"] {
            let claimants = rows.filter { $0.containedMessageIds.contains(target) }
            XCTAssertEqual(claimants.count, 1, "\(target) must resolve to exactly one row")
        }
    }

    // MARK: - Wiring

    /// The containment tests above pin the DATA. They do not prove the
    /// transcript uses it: reverting the resolution left every one of them
    /// green while restoring the original defect exactly. This reads the real
    /// source, which is the only thing that answers "is it wired".
    func testTranscriptResolvesJumpRequestsThroughContainment() {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/Transcript.swift")
        let source = (try? String(contentsOf: path, encoding: .utf8)) ?? ""
        XCTAssertFalse(source.isEmpty, "Transcript.swift must be readable")

        XCTAssertTrue(
            source.contains("containedMessageIds.contains"),
            "the transcript must translate a message id to its owning row"
        )
        XCTAssertTrue(
            source.contains("jumpRequest: resolvedJumpRequest"),
            "the RESOLVED request must reach the collection view, not the raw message id"
        )
    }
}

/// Viewport ownership between a jump and the tail-pin.
///
/// THE BUG THIS EXISTS FOR: dismissing the attachments sheet re-runs
/// `updateUIViewController`, which applies a snapshot BEFORE performing the
/// jump. That apply saw the view sitting at the tail, tailed again, and
/// scheduled `holdBottomWhileSettling`. The jump then set its offset — and the
/// already-queued settle loop pinned the view back to the bottom on the next
/// main-queue turn.
///
/// Every log line reported success: the row resolved, the scroll ran,
/// "transcript jump landed" was written. The operator saw nothing move.
///
/// A generation token makes ownership explicit: a jump claims the viewport, and
/// any settle loop queued under an older generation exits instead of fighting
/// it.
final class ScrollGenerationTests: XCTestCase {

    private func source(_ name: String) -> String {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/\(name)")
        return (try? String(contentsOf: path, encoding: .utf8)) ?? ""
    }

    func testJumpClaimsTheViewport() {
        let scrolling = source("ChatCollectionScrolling.swift")
        XCTAssertFalse(scrolling.isEmpty, "ChatCollectionScrolling.swift must be readable")
        XCTAssertTrue(
            scrolling.contains("scrollGeneration &+= 1"),
            "scrollToRow must claim the viewport so a queued tail-pin cannot undo it"
        )
    }

    func testBottomPinYieldsToANewerNavigation() {
        let scrolling = source("ChatCollectionScrolling.swift")
        // Both the entry guard and the per-turn guard matter: the loop can be
        // superseded before it starts AND between its turns.
        let guards = scrolling.components(separatedBy: "== self.scrollGeneration").count - 1
            + scrolling.components(separatedBy: "token == scrollGeneration").count - 1
        XCTAssertGreaterThanOrEqual(guards, 2, "the settle loop must check ownership on every turn")
    }

    func testJumpConvergesRatherThanPlacingOnce() {
        // Self-sizing rows move the target after a single placement, exactly
        // as they do for the bottom pin.
        let scrolling = source("ChatCollectionScrolling.swift")
        XCTAssertTrue(scrolling.contains("holdRowWhileSettling"),
                      "a jump must converge on its row, not place the offset once")
    }

    func testJumpIsNotAnimated() {
        // An animation runs against an offset the convergence loop is still
        // correcting, so the two fight.
        let view = source("ChatCollectionView.swift")
        // Matched on the argument, not the whole call: the signature gained a
        // chartId parameter for card-level anchoring, and a brittle full-call
        // match failed on a change that was not a regression.
        XCTAssertTrue(view.contains("scrollToRow(id: request.id"),
                      "the jump must go through scrollToRow")
        XCTAssertTrue(view.contains("animated: false)"),
                      "the jump must not animate while it is still converging")
    }
}
