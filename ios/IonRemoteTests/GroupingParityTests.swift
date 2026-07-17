import XCTest
@testable import IonRemote

/// Cross-platform transcript-grouping parity — iOS consumer.
///
/// Runs the shared fixture (desktop/src/shared/__tests__/fixtures/
/// grouping-parity.json, repo-relative like the contract manifest in
/// ContractSyncTests) through ToolGrouping's `groupConversationItems` in
/// CLASSIC mode and asserts the neutral-vocabulary shape. The desktop
/// consumer (grouping-parity.test.ts) runs the SAME fixture through
/// `groupMessages` — if either platform's grouping drifts, its consumer test
/// fails. This pins the "same conversation groups the same way on every
/// client" obligation.
final class GroupingParityTests: XCTestCase {

    private struct Fixture: Decodable {
        let cases: [FixtureCase]
    }

    private struct FixtureCase: Decodable {
        let name: String
        let messages: [FixtureMessage]
        let expected: [String]
    }

    private struct FixtureMessage: Decodable {
        let id: String
        let role: String
        let content: String
        let toolName: String?
        let toolId: String?
        let toolStatus: String?
    }

    /// Load the shared fixture from the repo-relative path (same candidate
    /// strategy as ContractSyncTests' manifest loading).
    private func loadFixture() throws -> Fixture {
        let candidates = [
            "../desktop/src/shared/__tests__/fixtures/grouping-parity.json",
            "desktop/src/shared/__tests__/fixtures/grouping-parity.json",
            "../../desktop/src/shared/__tests__/fixtures/grouping-parity.json",
            // Absolute fallback derived from this source file's location.
            URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()   // IonRemoteTests
                .deletingLastPathComponent()   // ios
                .deletingLastPathComponent()   // repo root
                .appendingPathComponent("desktop/src/shared/__tests__/fixtures/grouping-parity.json")
                .path,
        ]
        for candidate in candidates {
            let url = URL(fileURLWithPath: candidate)
            if FileManager.default.fileExists(atPath: url.path) {
                let data = try Data(contentsOf: url)
                return try JSONDecoder().decode(Fixture.self, from: data)
            }
        }
        throw XCTSkip("grouping-parity.json not found relative to the test working directory")
    }

    private func message(from f: FixtureMessage) -> Message {
        var m = Message(
            id: f.id,
            role: MessageRole(rawValue: f.role) ?? .system,
            content: f.content,
            toolStatus: f.toolStatus.flatMap { ToolStatus(rawValue: $0) },
            timestamp: 1
        )
        m.toolName = f.toolName
        m.toolId = f.toolId
        return m
    }

    /// Map iOS ConversationItem kinds onto the fixture's neutral vocabulary.
    private func neutralShape(_ messages: [Message]) -> [String] {
        groupConversationItems(messages, unifiedTurnView: false).map { item in
            switch item {
            case .toolGroup(let tools): return "toolGroup(\(tools.count))"
            case .user: return "user"
            case .assistant: return "assistant"
            case .thinking: return "thinking"
            case .compaction: return "compaction"
            case .system: return "system"
            case .agentTurn: return "agentTurn"
            }
        }
    }

    func testGroupingParityFixture() throws {
        let fixture = try loadFixture()
        XCTAssertFalse(fixture.cases.isEmpty, "fixture has no cases")
        for c in fixture.cases {
            let shape = neutralShape(c.messages.map(message(from:)))
            XCTAssertEqual(shape, c.expected, "case '\(c.name)' diverged from the shared fixture")
        }
    }
}
