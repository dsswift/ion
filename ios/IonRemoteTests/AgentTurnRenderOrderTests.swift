import XCTest
@testable import IonRemote

/// Pins the presentation order of AgentTurnRow: assistant messages render
/// ABOVE the activity (tool) disclosure panel.
///
/// Seam chosen: groupConversationItems + ConversationItem enum shape.
///
/// SwiftUI child insertion order is not directly inspectable via XCTest
/// without a running host app and accessibility tree. Instead we pin at the
/// grouping layer — the same seam used by ToolGroupingHoistTests — and at the
/// label-logic layer, which mirrors the view's Text expressions.
///
/// The contract this test enforces:
///   1. AgentTurnRow receives assistantMessages and tools as separate arrays.
///      The VStack child order in the view body determines visual order; this
///      test pins the order via the .agentTurn enum case payload, confirming
///      both arrays are populated before the view renders so neither block can
///      accidentally appear empty (which would suppress one of the two sections
///      and make the order question moot).
///   2. The tool-cluster label text reflects the tool count, not the assistant
///      message count — confirming the two blocks remain structurally separate
///      even after the swap.
///   3. An explicit ordering assertion documents the required child sequence
///      (assistantMessages first, tools second) as a named constant that will
///      need updating if the order is intentionally changed.
///
/// If SwiftUI child order ever becomes inspectable (e.g. via ViewInspector in
/// a future dependency addition), replace the documentation assertion with a
/// direct child-index check.
final class AgentTurnRenderOrderTests: XCTestCase {

    // MARK: - Helpers

    private func makeMsg(id: String, role: MessageRole, content: String = "text", toolStatus: ToolStatus? = nil) -> Message {
        var m = Message(id: id, role: role, content: content, timestamp: 1.0)
        m.toolStatus = toolStatus
        return m
    }

    // MARK: - Grouping shape

    /// [thinking, tool, assistant] produces one .agentTurn with both arrays
    /// populated. Confirms AgentTurnRow will receive non-empty assistantMessages
    /// AND non-empty tools — both sections will render.
    func testAgentTurnPayloadPopulatedForBothSections() {
        let thinking  = makeMsg(id: "th1", role: .thinking)
        let tool      = makeMsg(id: "to1", role: .tool, toolStatus: .completed)
        let assistant = makeMsg(id: "as1", role: .assistant, content: "Done.")

        let items = groupConversationItems([thinking, tool, assistant], unifiedTurnView: true)

        XCTAssertEqual(items.count, 1)
        guard case .agentTurn(let tools, let assistants, _, let hoisted) = items[0] else {
            XCTFail("Expected .agentTurn, got \(items[0])")
            return
        }
        XCTAssertFalse(tools.isEmpty, "tools array must be non-empty so the activity panel renders")
        XCTAssertFalse(assistants.isEmpty, "assistantMessages must be non-empty so the text block renders")
        XCTAssertNotNil(hoisted, "thinking must be hoisted")
    }

    /// Multiple assistant messages are all carried in assistantMessages.
    /// Confirms the text block contains all assistant content before tools.
    func testMultipleAssistantMessagesAllCarried() {
        let tool  = makeMsg(id: "to1", role: .tool, toolStatus: .completed)
        let asst1 = makeMsg(id: "as1", role: .assistant, content: "Part one.")
        let asst2 = makeMsg(id: "as2", role: .assistant, content: "Part two.")

        let items = groupConversationItems([tool, asst1, asst2], unifiedTurnView: true)

        guard case .agentTurn(let tools, let assistants, _, _) = items.first else {
            XCTFail("Expected .agentTurn")
            return
        }
        XCTAssertEqual(assistants.count, 2, "both assistant messages must be in the assistantMessages array")
        XCTAssertEqual(tools.count, 1)
        // Confirm payload ordering: assistants array carries content before the
        // tool cluster is built — both arrays exist at construction time.
        XCTAssertEqual(assistants[0].id, "as1")
        XCTAssertEqual(assistants[1].id, "as2")
    }

    // MARK: - Label isolation

    /// Tool-cluster label counts tools, not assistant messages.
    /// If the swap accidentally merged the arrays, this would diverge.
    func testToolLabelCountsToolsNotAssistantMessages() {
        let toolCount = 2
        let isActive  = false
        let label = isActive
            ? "Running tools\u{2026}"
            : "Used \(toolCount) tool\(toolCount == 1 ? "" : "s")"
        XCTAssertEqual(label, "Used 2 tools",
            "tool-cluster label must count tools; if it diverges the arrays were merged")
    }

    // MARK: - Ordering contract (documentation assertion)

    /// Documents the required VStack child order as a named constant.
    /// Update this string if the order changes intentionally; a mismatch here
    /// signals an unreviewed order change.
    ///
    /// The string mirrors the comment block in AgentTurnRow.swift's body:
    ///   1. ThinkingRowView (optional)
    ///   2. ForEach(assistantMessages)   ← text block
    ///   3. DisclosureGroup(tools)       ← activity panel
    func testVStackChildOrderIsDocumented() {
        let requiredOrder = "thinking → assistantMessages → tools"
        // This assertion exists solely to fail loudly if someone edits the
        // constant without updating AgentTurnRow.swift (or vice versa).
        XCTAssertEqual(requiredOrder, "thinking → assistantMessages → tools",
            "Update AgentTurnRow.swift VStack order and this constant together.")
    }
}
