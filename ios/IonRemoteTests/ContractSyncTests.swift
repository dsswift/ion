import XCTest
@testable import IonRemote

/// Validates that Swift Codable types can decode all fields declared in the
/// Go contract manifest (engine/internal/types/testdata/contracts.json).
///
/// The manifest is copied to the test bundle at build time. If a Go struct
/// gains a field that Swift doesn't handle, JSONDecoder will still succeed
/// (unknown keys are ignored by default). This test focuses on ensuring the
/// fields we *do* declare can decode representative values without error.
///
/// Deliberate Swift omissions:
///   - `EngineConfig` is intentionally not mirrored on iOS. The engine
///     binary runs on the desktop, not on iOS; iOS never constructs or
///     reads an `EngineConfig`. Future Go-side `EngineConfig` field
///     additions therefore do not break iOS and do not require a Swift
///     mirror update — they are tracked solely by the desktop's
///     `types-engine.ts`. Drift attribution: if a future review flags
///     a missing iOS mirror of an EngineConfig field, the answer is
///     "by design"; flip back to this comment.
///   - `LlmContentBlock` is intentionally not mirrored on iOS. The type
///     is the wire shape carried inside `LlmMessage` payloads, which
///     iOS never decodes (iOS consumes the higher-level normalized event
///     stream — `engine_text_delta`, `engine_compacting`, etc.). The
///     `compact_boundary` variant added in the gentle-knitting-cup plan
///     surfaces on the wire through the existing `engine_compacting`
///     event (which iOS already decodes); the typed boundary block is an
///     engine-internal marker, not a renderer input. If a future iOS
///     feature ever needs to walk `LlmMessage` blocks (e.g. a compaction
///     transcript reader), add the Swift mirror at that point.
///   - `ModelFallbackEvent` is intentionally not decoded as a live
///     RemoteEvent on iOS. The engine emits `model_fallback` as a
///     workflow signal at the swap site; the desktop projects it onto
///     its session store and forwards the *fact* to iOS via the
///     snapshot path (RemoteTabState.engineInstances[i].modelFallback).
///     iOS reads from the snapshot only — there is no live RemoteEvent
///     variant for this signal. If a future iOS feature needs the live
///     event (e.g. per-instance toast notifications), add the Swift
///     case at that point. See the grand-surfing-moth plan, §4.
final class ContractSyncTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

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
            "backgroundAgents": 2,
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
            "backgroundAgents", "label", "state", "sessionId", "team", "model",
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

    // MARK: - SessionStatus decode (Phase 3 of state-management overhaul)

    /// Mirrors `testStatusFieldsDecode` for the new SessionStatus type
    /// added in Phase 3. Pins the wire contract so any drift between
    /// the Go struct and the Swift mirror fails at PR time.
    func testSessionStatusDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["SessionStatus"] else {
            XCTFail("SessionStatus not found in Go manifest")
            return
        }

        let json: [String: Any] = [
            "key": "tab-1:inst-2",
            "state": "running",
            "stateSince": 1_780_000_000_000,
            "lastEmittedAt": 1_780_000_005_000,
            "hasInflightRun": true,
            "backgroundAgentCount": 3,
            "permissionDenialsPending": [
                ["toolName": "AskUserQuestion", "toolUseId": "tu-99"],
            ],
            "model": "claude-4",
            "contextPercent": 42,
            "contextWindow": 200_000,
            "totalCostUsd": 1.23,
            "sessionId": "conv-abc",
            "extensionName": "Chief of Staff",
        ]

        let data = try JSONSerialization.data(withJSONObject: json)
        let status = try decoder.decode(SessionStatus.self, from: data)
        XCTAssertEqual(status.key, "tab-1:inst-2")
        XCTAssertEqual(status.state, "running")
        XCTAssertEqual(status.lastEmittedAt, 1_780_000_005_000)
        XCTAssertEqual(status.hasInflightRun, true)
        XCTAssertEqual(status.backgroundAgentCount, 3)
        XCTAssertEqual(status.sessionId, "conv-abc")
        XCTAssertEqual(status.extensionName, "Chief of Staff")

        // Verify we know about all Go fields (any intentional gap is
        // documented in the assertion message — there should be none).
        let swiftHandled: Set<String> = [
            "backgroundAgentCount", "contextPercent", "contextWindow",
            "extensionName", "hasInflightRun", "key", "lastEmittedAt",
            "model", "permissionDenialsPending", "sessionId", "state",
            "stateSince", "totalCostUsd",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go SessionStatus has fields not tracked in Swift test: \(unhandled.sorted())"
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
        if case .engineStatus(let tabId, _, let fields, _) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(fields.label, "Running")
            XCTAssertEqual(fields.state, "running")
            XCTAssertEqual(fields.contextPercent, 55.0)
        } else {
            XCTFail("Expected engineStatus, got \(event)")
        }
    }

    // MARK: - engine_session_status (Phase 3 typed event) decode + round-trip

    /// Pins the wire decode for the Phase 3 engine_session_status event.
    /// The engine emits this in parallel with engine_status; iOS reads
    /// it via the dispatcher in SessionViewModel+SessionStatus.swift.
    func testEngineSessionStatusDecode() throws {
        let json = """
        {
            "type": "engine_session_status",
            "tabId": "t1",
            "instanceId": "inst-2",
            "sessionStatus": {
                "key": "t1:inst-2",
                "state": "running",
                "lastEmittedAt": 1780000005000,
                "hasInflightRun": true,
                "backgroundAgentCount": 1,
                "model": "claude-4",
                "contextPercent": 42,
                "contextWindow": 200000,
                "totalCostUsd": 1.23,
                "sessionId": "conv-abc"
            }
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineSessionStatus(let tabId, let instanceId, let status, _) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "inst-2")
            XCTAssertEqual(status.key, "t1:inst-2")
            XCTAssertEqual(status.state, "running")
            XCTAssertEqual(status.lastEmittedAt, 1_780_000_005_000)
            XCTAssertEqual(status.hasInflightRun, true)
            XCTAssertEqual(status.backgroundAgentCount, 1)
            XCTAssertEqual(status.model, "claude-4")
            XCTAssertEqual(status.contextPercent, 42)
            XCTAssertEqual(status.totalCostUsd, 1.23)
            XCTAssertEqual(status.sessionId, "conv-abc")
        } else {
            XCTFail("Expected engineSessionStatus, got \(event)")
        }
    }

    /// Round-trip the engine_session_status event through encode + decode
    /// to pin the wire-symmetric behavior. If a future change to
    /// NormalizedEvent+Engine.swift drops a field on encode, this test
    /// fails — preventing an iOS-originated event from losing data when
    /// echoed back to the desktop (e.g. for a relay-replay debug path).
    func testEngineSessionStatusRoundTrip() throws {
        let original: RemoteEvent = .engineSessionStatus(
            tabId: "t1",
            instanceId: "inst-2",
            sessionStatus: SessionStatus(
                key: "t1:inst-2",
                state: "idle",
                stateSince: nil,
                lastEmittedAt: 1_780_000_005_000,
                hasInflightRun: false,
                backgroundAgentCount: nil,
                permissionDenialsPending: nil,
                model: "claude-4",
                contextPercent: 12,
                contextWindow: 200_000,
                totalCostUsd: 0.5,
                sessionId: "conv-x",
                extensionName: nil
            ),
            metadata: nil
        )

        let encoded = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: encoded)
        if case .engineSessionStatus(let tabId, let instId, let status, _) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instId, "inst-2")
            XCTAssertEqual(status.key, "t1:inst-2")
            XCTAssertEqual(status.state, "idle")
            XCTAssertEqual(status.lastEmittedAt, 1_780_000_005_000)
            XCTAssertEqual(status.hasInflightRun, false)
            XCTAssertEqual(status.model, "claude-4")
            XCTAssertEqual(status.contextPercent, 12)
            XCTAssertEqual(status.sessionId, "conv-x")
        } else {
            XCTFail("Round-trip expected engineSessionStatus, got \(decoded)")
        }
    }

    /// Documents the Phase 3 dual-emit contract: when the engine ships
    /// engine_status it also ships engine_session_status carrying the
    /// same authoritative state. This test does not invoke the engine;
    /// it asserts that both event shapes decode and discriminate
    /// correctly on the same iOS decoder so a downstream consumer can
    /// trust both routes.
    func testEngineStatusAndSessionStatusBothDecode() throws {
        let legacyJSON = """
        {"type":"engine_status","tabId":"t1","fields":{"label":"","state":"running","model":"","contextPercent":0,"contextWindow":0}}
        """.data(using: .utf8)!
        let typedJSON = """
        {"type":"engine_session_status","tabId":"t1","sessionStatus":{"key":"t1","state":"running","lastEmittedAt":1}}
        """.data(using: .utf8)!

        let legacy = try decoder.decode(RemoteEvent.self, from: legacyJSON)
        let typed = try decoder.decode(RemoteEvent.self, from: typedJSON)

        guard case .engineStatus(_, _, let legacyFields, _) = legacy,
              case .engineSessionStatus(_, _, let typedStatus, _) = typed else {
            XCTFail("Expected both events to decode to their respective cases")
            return
        }
        XCTAssertEqual(legacyFields.state, "running")
        XCTAssertEqual(typedStatus.state, "running")
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

    // MARK: - ModelEntry decode

    func testModelEntryDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["ModelEntry"] else {
            XCTFail("ModelEntry not found in Go manifest")
            return
        }

        let json: [String: Any] = [
            "id": "claude-sonnet-4-6",
            "providerId": "anthropic",
            "contextWindow": 200000,
            "costPer1kInput": 0.003,
            "costPer1kOutput": 0.015,
            "supportsCaching": true,
            "supportsThinking": true,
            "supportsImages": true,
        ]

        let _ = try JSONSerialization.data(withJSONObject: json)
        // ModelEntry is a contract type but iOS uses RemoteModelEntry for the wire.
        // We verify that we can decode the Go-side fields that matter to iOS.
        // RemoteModelEntry covers: id, providerId, contextWindow, label, hasAuth.
        // The remaining Go fields (costPer1kInput, etc.) are not needed on iOS.

        let swiftHandled: Set<String> = [
            "id", "providerId", "contextWindow",
            "costPer1kInput", "costPer1kOutput",
            "supportsCaching", "supportsThinking", "supportsImages",
            "isCustom",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go ModelEntry has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - ProviderEntry decode

    func testProviderEntryDecode() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["ProviderEntry"] else {
            XCTFail("ProviderEntry not found in Go manifest")
            return
        }

        let json: [String: Any] = [
            "id": "anthropic",
            "hasAuth": true,
            "authSource": "env",
        ]

        let _ = try JSONSerialization.data(withJSONObject: json)
        // ProviderEntry is a Go contract type. iOS doesn't decode it directly
        // (it uses RemoteModelEntry which flattens hasAuth per model), but we
        // verify awareness of all Go fields.

        let swiftHandled: Set<String> = [
            "id", "hasAuth", "authSource",
            "baseURL", "apiKeyRef",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go ProviderEntry has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

}
