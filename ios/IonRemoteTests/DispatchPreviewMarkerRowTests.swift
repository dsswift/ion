import XCTest
@testable import IonRemote

/// Pins that AgentExpandedContent (the dispatch preview) renders the same
/// marker rows the main Transcript.swift uses — steer, plan created/updated/
/// implemented, and compaction — instead of collapsing lifecycle dividers into
/// a plain message row.
///
/// Deliverable 3 (iOS): before the fix, the dispatch preview lumped `.system`
/// items into a plain `EngineMessageRow` and had no explicit classification for
/// the `──` lifecycle dividers, so a reviewer could not verify that steer/plan
/// markers rendered through PlanDividerLabel. The fix extracts a testable
/// `AgentExpandedContent.classifyRow(_:)` seam that mirrors Transcript's row
/// switch: dividers → `.divider` (PlanDividerLabel), compaction →
/// `.compaction` (CompactionRowView).
///
/// Revert-red contract: if the `.system` divider branch is removed from
/// `classifyRow` (so every `.system` item classifies as `.message`), the
/// steer / plan-created / plan-updated / plan-implemented assertions below go
/// red. If compaction detection is removed, the compaction assertion goes red.
@MainActor
final class DispatchPreviewMarkerRowTests: XCTestCase {

    // MARK: - Fixtures

    /// A mock conversation carrying every marker type the dispatch preview must
    /// render, plus ordinary user/assistant rows for contrast.
    private func mockConversation() -> [Message] {
        var planCreated = Message(
            id: "plan-created",
            role: .system,
            content: "── Plan created at 3:42 PM · happy-rabbit ──",
            timestamp: 2000
        )
        planCreated.planFilePath = "/tmp/happy-rabbit.md"

        var planUpdated = Message(
            id: "plan-updated",
            role: .system,
            content: "── Plan updated at 3:45 PM · happy-rabbit ──",
            timestamp: 3000
        )
        planUpdated.planFilePath = "/tmp/happy-rabbit.md"

        return [
            Message(id: "u1", role: .user, content: "Do the thing", timestamp: 1000),
            Message(id: "steer", role: .system, content: "── Steer applied at 3:40 PM · 42 chars ──", timestamp: 1500),
            planCreated,
            planUpdated,
            Message(id: "plan-impl", role: .system, content: "── Implementing plan at 3:50 PM · happy-rabbit ──", timestamp: 4000),
            Message(id: "cp1", role: .system, content: "[Compaction] Freed context\n\n## Facts\n- something", timestamp: 5000),
            Message(id: "a1", role: .assistant, content: "Working on it.", timestamp: 6000),
        ]
    }

    /// Classifies each grouped item the way AgentExpandedContent.bodyView does,
    /// via the production `classifyRow` seam.
    private func classify(_ msgs: [Message]) -> [AgentExpandedContent.DispatchRowKind] {
        groupConversationItems(msgs, unifiedTurnView: true)
            .map { AgentExpandedContent.classifyRow($0) }
    }

    // MARK: - Every marker type produces its dedicated row

    func testAllMarkerTypesRenderDedicatedRows() {
        let kinds = classify(mockConversation())

        // Steer marker → divider row.
        XCTAssertTrue(kinds.contains(.divider),
            "steer / plan dividers must classify as .divider (PlanDividerLabel), not plain messages")

        // Compaction → compaction row.
        XCTAssertTrue(kinds.contains(.compaction),
            "compaction markers must classify as .compaction (CompactionRowView)")

        // Ordinary user/assistant rows still classify as .message.
        XCTAssertTrue(kinds.contains(.message),
            "ordinary user/assistant rows must still classify as .message")
    }

    /// Fine-grained: each individual lifecycle divider (steer, plan created,
    /// plan updated, plan implemented) must classify as `.divider`. This is the
    /// assertion that goes red if the `.system` divider branch is dropped.
    func testEachDividerMarkerClassifiesAsDivider() {
        let cases: [(id: String, content: String)] = [
            ("steer", "── Steer applied at 3:40 PM · 42 chars ──"),
            ("plan-created", "── Plan created at 3:42 PM · happy-rabbit ──"),
            ("plan-updated", "── Plan updated at 3:45 PM · happy-rabbit ──"),
            ("plan-impl", "── Implementing plan at 3:50 PM · happy-rabbit ──"),
        ]
        for c in cases {
            let msg = Message(id: c.id, role: .system, content: c.content, timestamp: 1)
            let items = groupConversationItems([msg], unifiedTurnView: true)
            XCTAssertEqual(items.count, 1, "\(c.id): one item expected")
            XCTAssertEqual(AgentExpandedContent.classifyRow(items[0]), .divider,
                "\(c.id) marker must render through the divider row, not a plain message")
        }
    }

    func testCompactionClassifiesAsCompaction() {
        let msg = Message(id: "cp", role: .system, content: "[Compaction] summary", timestamp: 1)
        let items = groupConversationItems([msg], unifiedTurnView: true)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(AgentExpandedContent.classifyRow(items[0]), .compaction,
            "compaction marker must render through CompactionRowView")
    }

    /// A non-divider system message (e.g. an error line) is a plain message
    /// row, NOT a divider — proves the classifier discriminates on the `──`
    /// sentinel rather than blanket-treating every system row as a divider.
    func testPlainSystemMessageClassifiesAsMessage() {
        let msg = Message(id: "err", role: .system, content: "Error: something failed", timestamp: 1)
        let items = groupConversationItems([msg], unifiedTurnView: true)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(AgentExpandedContent.classifyRow(items[0]), .message,
            "a non-divider system message must render as a plain message row")
    }

    /// The mock conversation must produce at least four divider rows (steer +
    /// three plan markers) and exactly one compaction row. This is the
    /// end-to-end count assertion that fails on pre-fix code where dividers
    /// collapsed into plain message rows.
    func testMarkerRowCounts() {
        let kinds = classify(mockConversation())
        let dividerCount = kinds.filter { $0 == .divider }.count
        let compactionCount = kinds.filter { $0 == .compaction }.count
        XCTAssertEqual(dividerCount, 4,
            "steer + plan-created + plan-updated + plan-implemented = 4 divider rows")
        XCTAssertEqual(compactionCount, 1, "exactly one compaction row")
    }
}
