import XCTest
@testable import IonRemote

/// Validates that Swift Codable types can decode all fields declared in the
/// Go contract manifest (engine/internal/types/testdata/contracts.json).
///
/// The manifest is copied to the test bundle at build time. If a Go struct
/// gains a field that Swift doesn't handle, JSONDecoder will still succeed
/// (unknown keys are ignored by default). This test focuses on ensuring the
/// fields we *do* declare can decode representative values without error.
final class ContractSyncTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Manifest loading

    private struct Manifest: Decodable {
        let normalizedEvents: [String: [String]?]
        let engineEvent: [String]
        let sharedTypes: [String: [String]]
    }

    /// Load the Go contract manifest from the repo-relative path.
    /// In local test runs the working directory is the ios/ folder.
    private func loadManifest() throws -> Manifest {
        // Try repo-relative paths (Xcode sets cwd to the project root or
        // a DerivedData folder depending on the run mode).
        let candidates = [
            // Running from ios/ directory
            "../engine/internal/types/testdata/contracts.json",
            // Running from repo root
            "engine/internal/types/testdata/contracts.json",
        ]

        for candidate in candidates {
            let url = URL(fileURLWithPath: candidate)
            if FileManager.default.fileExists(atPath: url.path) {
                let data = try Data(contentsOf: url)
                return try JSONDecoder().decode(Manifest.self, from: data)
            }
        }

        // Fallback: search up from the source file location
        var dir = URL(fileURLWithPath: #file).deletingLastPathComponent()
        for _ in 0..<5 {
            dir = dir.deletingLastPathComponent()
            let candidate = dir
                .appendingPathComponent("engine/internal/types/testdata/contracts.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try JSONDecoder().decode(Manifest.self, from: data)
            }
        }

        throw ContractError.manifestNotFound
    }

    private enum ContractError: Error {
        case manifestNotFound
    }

    // MARK: - StatusFields decode

    func testStatusFieldsDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["StatusFields"] else {
            XCTFail("StatusFields not found in Go manifest")
            return
        }

        // Build a JSON payload with representative values for all Go fields
        let json: [String: Any] = [
            "label": "test",
            "state": "idle",
            "sessionId": "sess-1",
            "team": "alpha",
            "model": "claude-4",
            "contextPercent": 42,
            "contextWindow": 200000,
            "totalCostUsd": 1.23,
            "permissionDenials": [
                ["toolName": "bash", "toolUseId": "tu-1"],
            ],
            "extensionName": "Chief of Staff",
        ]

        let data = try JSONSerialization.data(withJSONObject: json)
        let fields = try decoder.decode(StatusFields.self, from: data)
        XCTAssertEqual(fields.label, "test")
        XCTAssertEqual(fields.state, "idle")
        XCTAssertEqual(fields.sessionId, "sess-1")
        XCTAssertEqual(fields.model, "claude-4")
        XCTAssertEqual(fields.contextPercent, 42.0) // Double decodes int fine
        XCTAssertEqual(fields.extensionName, "Chief of Staff")

        // Verify we know about all Go fields (document any intentional gaps)
        let swiftHandled: Set<String> = [
            "label", "state", "sessionId", "team", "model",
            "contextPercent", "contextWindow", "totalCostUsd",
            "permissionDenials", "extensionName",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go StatusFields has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - EngineEvent decode (engine_status with StatusFields)

    func testEngineStatusDecode() throws {
        let json = """
        {
            "type": "engine_status",
            "tabId": "t1",
            "fields": {
                "label": "Running",
                "state": "running",
                "model": "claude-4",
                "contextPercent": 55,
                "contextWindow": 200000
            }
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineStatus(let tabId, _, let fields) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(fields.label, "Running")
            XCTAssertEqual(fields.state, "running")
            XCTAssertEqual(fields.contextPercent, 55.0)
        } else {
            XCTFail("Expected engineStatus, got \(event)")
        }
    }

    // MARK: - EngineEvent variants decode

    func testEngineTextDeltaDecode() throws {
        let json = """
        {"type":"engine_text_delta","tabId":"t1","text":"hello"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineTextDelta(_, _, let text) = event {
            XCTAssertEqual(text, "hello")
        } else {
            XCTFail("Expected engineTextDelta")
        }
    }

    func testEngineToolStartDecode() throws {
        let json = """
        {"type":"engine_tool_start","tabId":"t1","toolName":"bash","toolId":"tid-1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolStart(_, _, let name, let id) = event {
            XCTAssertEqual(name, "bash")
            XCTAssertEqual(id, "tid-1")
        } else {
            XCTFail("Expected engineToolStart")
        }
    }

    func testEngineToolEndDecode() throws {
        let json = """
        {"type":"engine_tool_end","tabId":"t1","toolId":"tid-1","result":"ok","isError":false}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolEnd(_, _, let id, let result, let isError) = event {
            XCTAssertEqual(id, "tid-1")
            XCTAssertEqual(result, "ok")
            XCTAssertFalse(isError)
        } else {
            XCTFail("Expected engineToolEnd")
        }
    }

    func testEngineDeadDecode() throws {
        let json = """
        {"type":"engine_dead","tabId":"t1","exitCode":1,"signal":null,"stderrTail":["error"]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDead(_, _, let exitCode, let signal, let tail) = event {
            XCTAssertEqual(exitCode, 1)
            XCTAssertNil(signal)
            XCTAssertEqual(tail, ["error"])
        } else {
            XCTFail("Expected engineDead")
        }
    }

    func testEngineMessageEndDecode() throws {
        let json = """
        {"type":"engine_message_end","tabId":"t1","usage":{"inputTokens":100,"outputTokens":50,"contextPercent":30,"cost":0.01}}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineMessageEnd(_, _, let input, let output, let pct, let cost) = event {
            XCTAssertEqual(input, 100)
            XCTAssertEqual(output, 50)
            XCTAssertEqual(pct, 30.0)
            XCTAssertEqual(cost, 0.01)
        } else {
            XCTFail("Expected engineMessageEnd")
        }
    }

    func testEngineDialogDecode() throws {
        let json = """
        {"type":"engine_dialog","tabId":"t1","dialogId":"d1","method":"select","title":"Pick","options":["a","b"]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDialog(_, _, let dialogId, let method, let title, let opts, _) = event {
            XCTAssertEqual(dialogId, "d1")
            XCTAssertEqual(method, "select")
            XCTAssertEqual(title, "Pick")
            XCTAssertEqual(opts, ["a", "b"])
        } else {
            XCTFail("Expected engineDialog")
        }
    }

    func testEngineAgentStateDecode() throws {
        let json = """
        {"type":"engine_agent_state","tabId":"t1","agents":[{"name":"coder","status":"running","metadata":{"displayName":"Coder","type":"specialist","visibility":"always","invited":true}}]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineAgentState(_, _, let agents) = event {
            XCTAssertEqual(agents.count, 1)
            XCTAssertEqual(agents[0].name, "coder")
            XCTAssertEqual(agents[0].status, "running")
        } else {
            XCTFail("Expected engineAgentState")
        }
    }

    // MARK: - StatusFields with contextPercent as int (Go sends int)

    func testStatusFieldsContextPercentAsInt() throws {
        // Go contextPercent is int; Swift decodes as Double — should work
        let json = """
        {"label":"test","state":"idle","model":"claude-4","contextPercent":75,"contextWindow":200000}
        """.data(using: .utf8)!
        let fields = try decoder.decode(StatusFields.self, from: json)
        XCTAssertEqual(fields.contextPercent, 75.0)
    }

    // MARK: - MessageEndUsage decode

    func testMessageEndUsageDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["MessageEndUsage"] else {
            XCTFail("MessageEndUsage not found in Go manifest")
            return
        }

        let json = """
        {"inputTokens":100,"outputTokens":50,"contextPercent":30,"cost":0.5}
        """.data(using: .utf8)!
        let usage = try decoder.decode(EngineMessageEndUsage.self, from: json)
        XCTAssertEqual(usage.inputTokens, 100)
        XCTAssertEqual(usage.outputTokens, 50)

        let swiftHandled: Set<String> = [
            "inputTokens", "outputTokens", "contextPercent", "cost",
        ]
        let unhandled = Set(goFields).subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go MessageEndUsage has fields not tracked in Swift: \(unhandled.sorted())"
        )
    }
}
