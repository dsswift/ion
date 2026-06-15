import XCTest
@testable import IonRemote

/// Tests for `PendingCard.outcome` — the iOS half of the cross-client
/// pending-card rule. Mirrors desktop's pending-card.test.ts so both clients
/// agree: a restored AskUserQuestion / ExitPlanMode card appears only when the
/// pending tool is still outstanding (no trailing /clear divider, no trailing
/// user message).
final class PendingCardTests: XCTestCase {
    private func msg(_ id: String, _ role: MessageRole, content: String = "", toolName: String? = nil) -> Message {
        Message(id: id, role: role, content: content, toolName: toolName, timestamp: 0)
    }

    private let clearDivider = "── Cleared at 9:41 AM ──"

    func testFoundWhenLastToolIsAskUserQuestion() {
        let messages = [
            msg("u0", .user, content: "do it"),
            msg("q1", .tool, toolName: "AskUserQuestion"),
        ]
        guard case .found(let tool) = PendingCard.outcome(for: messages) else {
            return XCTFail("expected .found")
        }
        XCTAssertEqual(tool.id, "q1")
    }

    func testFoundWhenLastToolIsExitPlanMode() {
        let messages = [msg("a", .assistant, content: "plan"), msg("p1", .tool, toolName: "ExitPlanMode")]
        guard case .found = PendingCard.outcome(for: messages) else {
            return XCTFail("expected .found")
        }
    }

    func testSuppressedByClearDividerAfterTool() {
        let messages = [
            msg("q1", .tool, toolName: "AskUserQuestion"),
            msg("c1", .system, content: clearDivider),
        ]
        XCTAssertEqual(PendingCard.outcome(for: messages), .suppressedByClear)
    }

    func testSuppressedByUserMessageAfterTool() {
        let messages = [
            msg("q1", .tool, toolName: "AskUserQuestion"),
            msg("u1", .user, content: "never mind"),
        ]
        XCTAssertEqual(PendingCard.outcome(for: messages), .suppressedByUser)
    }

    func testNoneWhenLastToolIsNotPendingCardTool() {
        let messages = [
            msg("q1", .tool, toolName: "AskUserQuestion"),
            msg("b1", .tool, toolName: "Bash"),
        ]
        XCTAssertEqual(PendingCard.outcome(for: messages), .none)
    }

    func testNoneWhenNoToolMessages() {
        XCTAssertEqual(PendingCard.outcome(for: [msg("a", .assistant, content: "hi")]), .none)
        XCTAssertEqual(PendingCard.outcome(for: []), .none)
    }

    func testClearDividerBeforeTheToolDoesNotSuppress() {
        // A prior clear, then a fresh question after it → the question is live.
        let messages = [
            msg("c1", .system, content: clearDivider),
            msg("q1", .tool, toolName: "AskUserQuestion"),
        ]
        guard case .found = PendingCard.outcome(for: messages) else {
            return XCTFail("expected .found — clear before the question must not suppress")
        }
    }
}
