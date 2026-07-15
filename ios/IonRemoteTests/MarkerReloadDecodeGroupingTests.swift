import XCTest
@testable import IonRemote

/// Pins the marker-reload decode + grouping parity on iOS (commit 7 of the
/// marker-reload plan).
///
/// The engine now yields system-role `SessionMessage` rows for compaction,
/// plan, and steer markers on historical load (see engine
/// `conversation/list.go` flattenEntries). Each row carries a content sentinel
/// (`[Compaction]` for compaction, `──` for plan/steer) plus structured
/// `marker*` fields. The desktop history mapper (session-message-mapper.ts)
/// builds the display content and carries `planFilePath` before iOS ever sees
/// the row over `desktop_conversation_history`; iOS then routes marker rows by
/// their content sentinel through the `groupConversationItems` grouper.
///
/// These tests pin two things:
///   1. DECODE — a raw engine marker row decodes into a `Message` with the
///      expected role/content and structured fields (`markerKind`, and
///      `planFilePath` populated from `markerPlanFilePath` on the engine wire).
///   2. GROUPING — a decoded marker row routes to the correct
///      `ConversationItem` case: `[Compaction]` → `.compaction`; the `──`
///      plan/steer dividers → `.system` (the divider render path).
///
/// Regression contract: if the grouper stops routing `[Compaction]` to
/// `.compaction`, or if `Message` drops the `markerKind` / `planFilePath`
/// decode, these go red.
final class MarkerReloadDecodeGroupingTests: XCTestCase {

    private let decoder = JSONDecoder()

    // MARK: - engineJSON decode wrapper
    //
    // `Message(engineJSON:)` takes a `Decoder`; wrap a single JSON object so
    // tests can exercise the raw-engine-wire decode path (the agent-history
    // path) the same way NormalizedEvent+EngineDecoder does.
    private struct EngineMessageWrapper: Decodable {
        let message: Message
        init(from decoder: Decoder) throws {
            message = try Message(engineJSON: decoder)
        }
    }

    private func decodeEngine(_ json: String) throws -> Message {
        let data = Data(json.utf8)
        return try decoder.decode(EngineMessageWrapper.self, from: data).message
    }

    private func decodeStandard(_ json: String) throws -> Message {
        try decoder.decode(Message.self, from: Data(json.utf8))
    }

    // MARK: - Compaction

    func testCompactionRowDecodesAndGroups() throws {
        let json = """
        {
          "role": "system",
          "content": "[Compaction]",
          "timestamp": 123,
          "markerKind": "compaction",
          "markerMessagesBefore": 10,
          "markerMessagesAfter": 5,
          "markerClearedBlocks": 3,
          "markerStrategy": "partial",
          "markerSummary": "## Facts\\n- kept X"
        }
        """
        let msg = try decodeEngine(json)
        XCTAssertEqual(msg.role, .system)
        XCTAssertEqual(msg.content, "[Compaction]")
        XCTAssertEqual(msg.markerKind, "compaction")

        // Grouping (classic + unified) routes the [Compaction] sentinel to the
        // compaction item so CompactionRowView renders it.
        for unified in [false, true] {
            let items = groupConversationItems([msg], unifiedTurnView: unified)
            XCTAssertEqual(items.count, 1)
            guard case .compaction = items[0] else {
                return XCTFail("compaction row must group to .compaction (unified=\(unified)), got \(items[0])")
            }
        }
    }

    // MARK: - Plan divider

    func testPlanMarkerDecodesWithPathAndGroups() throws {
        // Raw engine wire: content is the bare `──` sentinel and the plan path
        // rides under `markerPlanFilePath`. The engineJSON decoder falls back to
        // it so the decoded Message carries a planFilePath for the slug link.
        let json = """
        {
          "role": "system",
          "content": "──",
          "timestamp": 123,
          "markerKind": "plan",
          "markerPlanOperation": "created",
          "markerPlanFilePath": "/test/plan.md",
          "markerPlanSlug": "plan-slug"
        }
        """
        let msg = try decodeEngine(json)
        XCTAssertEqual(msg.role, .system)
        XCTAssertEqual(msg.content, "──")
        XCTAssertEqual(msg.markerKind, "plan")
        XCTAssertEqual(msg.planFilePath, "/test/plan.md",
                       "engine plan marker path (markerPlanFilePath) must populate planFilePath")

        // A `──` plan divider groups to a plain system row (the divider render
        // path — PlanDividerLabel), NOT to .compaction.
        for unified in [false, true] {
            let items = groupConversationItems([msg], unifiedTurnView: unified)
            XCTAssertEqual(items.count, 1)
            guard case .system(let m) = items[0] else {
                return XCTFail("plan divider must group to .system (unified=\(unified)), got \(items[0])")
            }
            XCTAssertEqual(m.planFilePath, "/test/plan.md")
        }
    }

    func testPlanMarkerDesktopMappedContentIsLinkable() throws {
        // The desktop history mapper builds display content + planFilePath before
        // iOS decodes the row on the standard Codable path. Pin that a reloaded,
        // desktop-mapped plan divider stays linkable through PlanDividerLabel.
        let json = """
        {
          "id": "d1",
          "role": "system",
          "content": "── Plan created at 3:42 PM · plan-slug ──",
          "timestamp": 123,
          "planFilePath": "/test/plan.md"
        }
        """
        let msg = try decodeStandard(json)
        XCTAssertEqual(msg.role, .system)
        XCTAssertEqual(msg.planFilePath, "/test/plan.md")

        let items = groupConversationItems([msg])
        guard case .system = items.first else {
            return XCTFail("mapped plan divider must group to .system, got \(String(describing: items.first))")
        }
        // testLinkPath / testLinkSlug are DEBUG-only seams; test builds are Debug
        // (matching PlanDividerCreatedUpdatedTests, which uses them unguarded).
        let label = PlanDividerLabel(message: msg, onTapPlan: { _ in })
        XCTAssertEqual(label.testLinkPath, "/test/plan.md", "reloaded plan divider must stay linkable")
        XCTAssertEqual(label.testLinkSlug, "plan-slug")
    }

    // MARK: - Steer divider

    func testSteerMarkerDecodesAndGroups() throws {
        let json = """
        {
          "role": "system",
          "content": "──",
          "timestamp": 123,
          "markerKind": "steer",
          "markerMessageLength": 42
        }
        """
        let msg = try decodeEngine(json)
        XCTAssertEqual(msg.role, .system)
        XCTAssertEqual(msg.content, "──")
        XCTAssertEqual(msg.markerKind, "steer")
        // Steer carries no plan path.
        XCTAssertNil(msg.planFilePath)

        for unified in [false, true] {
            let items = groupConversationItems([msg], unifiedTurnView: unified)
            XCTAssertEqual(items.count, 1)
            guard case .system = items[0] else {
                return XCTFail("steer divider must group to .system (unified=\(unified)), got \(items[0])")
            }
        }
    }

    // MARK: - Tool-result image reload

    /// The engine's flattenEntries replays a persisted tool-result image as a
    /// `SessionMessage.attachments` entry on the owning tool row (image support,
    /// historical reload path). The engineJSON decoder (direct engine-wire path,
    /// used by agent conversation history) must decode that attachment so
    /// engine-generated tool images survive reload — matching the desktop→iOS
    /// conversationHistory path which decodes attachments via standard Codable.
    ///
    /// Regression contract: revert the `attachments` decode in `Message(engineJSON:)`
    /// (back to `attachments = nil`) and this goes red — the reloaded image is lost.
    func testToolImageAttachmentDecodesOnEngineWire() throws {
        let json = """
        {
          "role": "tool",
          "content": "[Image: screenshot]",
          "timestamp": 123,
          "toolName": "Screenshot",
          "toolId": "tu_shot",
          "attachments": [
            {
              "id": "img:/home/u/.ion/conversations/c/images/abc.png",
              "type": "image",
              "name": "abc.png",
              "path": "/home/u/.ion/conversations/c/images/abc.png"
            }
          ]
        }
        """
        let msg = try decodeEngine(json)
        XCTAssertEqual(msg.role, .tool)
        XCTAssertEqual(msg.attachments?.count, 1,
                       "engine tool-result image must decode on the engine-wire path")
        XCTAssertEqual(msg.attachments?.first?.type, .image)
        XCTAssertEqual(msg.attachments?.first?.path,
                       "/home/u/.ion/conversations/c/images/abc.png")
    }

    /// The desktop→iOS conversationHistory path decodes Message via standard
    /// Codable; pin that the same reloaded tool image survives there too, so both
    /// reload paths reach parity.
    func testToolImageAttachmentDecodesOnStandardWire() throws {
        let json = """
        {
          "id": "t1",
          "role": "tool",
          "content": "[Image: screenshot]",
          "timestamp": 123,
          "toolName": "Screenshot",
          "toolId": "tu_shot",
          "attachments": [
            {
              "id": "img:/c/images/abc.png",
              "type": "image",
              "name": "abc.png",
              "path": "/c/images/abc.png"
            }
          ]
        }
        """
        let msg = try decodeStandard(json)
        XCTAssertEqual(msg.attachments?.count, 1)
        XCTAssertEqual(msg.attachments?.first?.type, .image)
        XCTAssertEqual(msg.attachments?.first?.path, "/c/images/abc.png")
    }

    // MARK: - Mixed reload transcript

    func testMixedMarkerTranscriptGroupsInOrder() throws {
        // A realistic reload: user turn, compaction marker, plan divider, steer
        // divider. Each marker routes to its correct case, interleaved with the
        // ordinary turn, preserving order.
        let user = try decodeStandard(#"{"id":"u1","role":"user","content":"hi","timestamp":1}"#)
        let compaction = try decodeEngine(#"{"role":"system","content":"[Compaction]","timestamp":2,"markerKind":"compaction","markerMessagesBefore":8,"markerMessagesAfter":3}"#)
        let plan = try decodeEngine(#"{"role":"system","content":"──","timestamp":3,"markerKind":"plan","markerPlanOperation":"created","markerPlanFilePath":"/p.md","markerPlanSlug":"p"}"#)
        let steer = try decodeEngine(#"{"role":"system","content":"──","timestamp":4,"markerKind":"steer","markerMessageLength":7}"#)

        let items = groupConversationItems([user, compaction, plan, steer])
        XCTAssertEqual(items.count, 4)
        guard case .user = items[0] else { return XCTFail("item0 should be .user") }
        guard case .compaction = items[1] else { return XCTFail("item1 should be .compaction") }
        guard case .system(let planItem) = items[2] else { return XCTFail("item2 should be .system (plan)") }
        XCTAssertEqual(planItem.planFilePath, "/p.md")
        guard case .system = items[3] else { return XCTFail("item3 should be .system (steer)") }
    }
}
