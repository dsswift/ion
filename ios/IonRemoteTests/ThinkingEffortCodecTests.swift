import XCTest
@testable import IonRemote

/// Codec + snapshot tests for the per-conversation extended-thinking feature.
///
/// Covers:
///   1. `desktop_set_thinking_effort` RemoteCommand encodes the canonical wire
///      shape (type + tabId + effort) and round-trips through decode.
///   2. `RemoteTabState.thinkingEffort` decodes from the snapshot JSON (tab
///      level) and is nil when absent.
///   3. `ConversationInstanceInfo.thinkingEffort` decodes (engine sub-tab).
///   4. `RemoteModelEntry.thinkingEfforts` decodes so the iOS control can gate
///      on model support; nil when absent (back-compat with older desktops).
///
/// Pure encode/decode — no network or MainActor.
final class ThinkingEffortCodecTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func testEncodeSetThinkingEffort() throws {
        let cmd = RemoteCommand.setThinkingEffort(tabId: "t1", effort: "high")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_set_thinking_effort")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["effort"] as? String, "high")
    }

    func testSetThinkingEffortRoundTrip() throws {
        let cmd = RemoteCommand.setThinkingEffort(tabId: "t2", effort: "low")
        let data = try encoder.encode(cmd)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        guard case let .setThinkingEffort(tabId, effort) = decoded else {
            return XCTFail("decoded to wrong case: \(decoded)")
        }
        XCTAssertEqual(tabId, "t2")
        XCTAssertEqual(effort, "low")
    }

    func testTabStateThinkingEffortDecodes() throws {
        let json = """
        { "id": "t1", "title": "T", "status": "idle", "workingDirectory": "/x",
          "permissionMode": "auto", "thinkingEffort": "medium", "permissionQueue": [] }
        """.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertEqual(tab.thinkingEffort, "medium")
    }

    func testTabStateThinkingEffortNilWhenAbsent() throws {
        let json = """
        { "id": "t1", "title": "T", "status": "idle", "workingDirectory": "/x",
          "permissionMode": "auto", "permissionQueue": [] }
        """.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertNil(tab.thinkingEffort)
    }

    func testInstanceThinkingEffortDecodes() throws {
        let json = """
        { "id": "i1", "label": "Main", "thinkingEffort": "high" }
        """.data(using: .utf8)!
        let inst = try decoder.decode(ConversationInstanceInfo.self, from: json)
        XCTAssertEqual(inst.thinkingEffort, "high")
    }

    func testModelEntryThinkingEffortsDecode() throws {
        let json = """
        { "id": "claude-sonnet-4-6", "providerId": "anthropic", "label": "Sonnet 4.6",
          "contextWindow": 200000, "hasAuth": true,
          "thinkingMode": "adaptive", "thinkingEfforts": ["low","medium","high"] }
        """.data(using: .utf8)!
        let model = try decoder.decode(RemoteModelEntry.self, from: json)
        XCTAssertEqual(model.thinkingMode, "adaptive")
        XCTAssertEqual(model.thinkingEfforts, ["low", "medium", "high"])
    }

    func testModelEntryThinkingEffortsNilWhenAbsent() throws {
        let json = """
        { "id": "gpt-4.1", "providerId": "openai", "label": "GPT-4.1",
          "contextWindow": 1000000, "hasAuth": true }
        """.data(using: .utf8)!
        let model = try decoder.decode(RemoteModelEntry.self, from: json)
        XCTAssertNil(model.thinkingEfforts)
    }
}
