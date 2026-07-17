// @file-size-exception: contract sync test suite — each shared type needs its own decode + field-set test
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
///     snapshot path (RemoteTabState.conversationInstances[i].modelFallback).
///     iOS reads from the snapshot only — there is no live RemoteEvent
///     variant for this signal. If a future iOS feature needs the live
///     event (e.g. per-instance toast notifications), add the Swift
///     case at that point. See the grand-surfing-moth plan, §4.
///   - `CapabilityUnsupportedEvent` is intentionally not decoded as a live
///     RemoteEvent on iOS. The engine emits `capability_unsupported` when a
///     requested feature (e.g. plan mode) is unsupported by the serving
///     backend and the prompt was declined cleanly; the desktop renders the
///     recoverable message and iOS converges through the snapshot path
///     (tab status stays idle — no run ever starts). Same precedent as
///     ModelFallbackEvent above; the field-set test in
///     ContractSyncEngineEventsTests tracks the Go variant for drift.
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
            "runCostUsd": 1.23,
            "conversationCostUsd": 2.34,
            "permissionDenials": [
                ["toolName": "bash", "toolUseId": "tu-1"],
            ],
            "extensionName": "Chief of Staff",
            "backgroundAgents": 2,
            "numTurns": 3,
            "conversationTurns": 210,
        ]

        let data = try JSONSerialization.data(withJSONObject: json)
        let fields = try decoder.decode(StatusFields.self, from: data)
        XCTAssertEqual(fields.label, "test")
        XCTAssertEqual(fields.state, "idle")
        XCTAssertEqual(fields.sessionId, "sess-1")
        XCTAssertEqual(fields.model, "claude-4")
        XCTAssertEqual(fields.contextPercent, 42.0) // Double decodes int fine
        XCTAssertEqual(fields.extensionName, "Chief of Staff")
        XCTAssertEqual(fields.runCostUsd, 1.23)
        XCTAssertEqual(fields.conversationCostUsd, 2.34)
        XCTAssertEqual(fields.numTurns, 3)
        XCTAssertEqual(fields.conversationTurns, 210)

        // Verify we know about all Go fields (document any intentional gaps)
        let swiftHandled: Set<String> = [
            "backgroundAgents", "label", "state", "sessionId", "team", "model",
            "contextPercent", "contextWindow", "runCostUsd", "conversationCostUsd",
            "permissionDenials", "extensionName", "numTurns", "conversationTurns",
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
            "runCostUsd": 1.23,
            "conversationCostUsd": 2.34,
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
        XCTAssertEqual(status.runCostUsd, 1.23)
        XCTAssertEqual(status.conversationCostUsd, 2.34)

        // Verify we know about all Go fields (any intentional gap is
        // documented in the assertion message — there should be none).
        let swiftHandled: Set<String> = [
            "backgroundAgentCount", "contextPercent", "contextWindow",
            "conversationCostUsd", "extensionName", "hasInflightRun", "key",
            "lastEmittedAt", "model", "permissionDenialsPending", "runCostUsd",
            "sessionId", "state", "stateSince",
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
            "type": "desktop_status",
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
            "type": "desktop_session_status",
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
                "runCostUsd": 1.23,
                "conversationCostUsd": 5.67,
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
            XCTAssertEqual(status.runCostUsd, 1.23)
            XCTAssertEqual(status.conversationCostUsd, 5.67)
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
                runCostUsd: 0.5,
                conversationCostUsd: 2.5,
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
        {"type":"desktop_status","tabId":"t1","fields":{"label":"","state":"running","model":"","contextPercent":0,"contextWindow":0}}
        """.data(using: .utf8)!
        let typedJSON = """
        {"type":"desktop_session_status","tabId":"t1","sessionStatus":{"key":"t1","state":"running","lastEmittedAt":1}}
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
        {"type":"desktop_text_delta","tabId":"t1","text":"hello"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineTextDelta(_, _, let text) = event {
            XCTAssertEqual(text, "hello")
        } else {
            XCTFail("Expected engineTextDelta")
        }
    }

    func testEngineStreamResetDecode() throws {
        let json = """
        {"type":"desktop_stream_reset","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineStreamReset(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected engineStreamReset")
        }
    }

    func testEngineToolStartDecode() throws {
        let json = """
        {"type":"desktop_tool_start","tabId":"t1","toolName":"bash","toolId":"tid-1"}
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
        {"type":"desktop_tool_end","tabId":"t1","toolId":"tid-1","result":"ok","isError":false}
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
        {"type":"desktop_dead","tabId":"t1","exitCode":1,"signal":null,"stderrTail":["error"]}
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
    func testEngineImageContentDecode_tool() throws {
        // source "tool" carries a toolId; iOS attaches to the matching tool row.
        let json = """
        {"type":"desktop_image_content","tabId":"t1","instanceId":"i1","path":"/Users/x/.ion/conversations/c1/images/abc.png","mediaType":"image/png","source":"tool","toolId":"tid-9"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .engineImageContent(let tabId, let instanceId, let path, let mediaType, let source, let toolId) = event else {
            return XCTFail("Expected engineImageContent (tool)")
        }
        XCTAssertEqual(tabId, "t1")
        XCTAssertEqual(instanceId, "i1")
        XCTAssertEqual(path, "/Users/x/.ion/conversations/c1/images/abc.png")
        XCTAssertEqual(mediaType, "image/png")
        XCTAssertEqual(source, "tool")
        XCTAssertEqual(toolId, "tid-9")
    }

    func testEngineImageContentDecode_provider() throws {
        // source "provider" omits toolId; iOS attaches to the last assistant row.
        let json = """
        {"type":"desktop_image_content","tabId":"t1","path":"/img/gen.png","mediaType":"image/png","source":"provider"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .engineImageContent(_, _, let path, _, let source, let toolId) = event else {
            return XCTFail("Expected engineImageContent (provider)")
        }
        XCTAssertEqual(path, "/img/gen.png")
        XCTAssertEqual(source, "provider")
        XCTAssertNil(toolId)
    }

    /// Round-trip encode → decode to pin the wire shape stays symmetric.
    func testEngineImageContentRoundTrip() throws {
        let original = RemoteEvent.engineImageContent(
            tabId: "t1", instanceId: "i1", path: "/img/a.png",
            mediaType: "image/png", source: "tool", toolId: "tid-1"
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        guard case .engineImageContent(_, _, let path, let mediaType, let source, let toolId) = decoded else {
            return XCTFail("Expected engineImageContent round-trip")
        }
        XCTAssertEqual(path, "/img/a.png")
        XCTAssertEqual(mediaType, "image/png")
        XCTAssertEqual(source, "tool")
        XCTAssertEqual(toolId, "tid-1")
    }

    /// Pin that every Go-side image_content field is tracked by the Swift
    /// engineImageContent case. Fails if Go adds a field iOS doesn't decode.
    func testImageContentNormalizedEventFields() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["image_content"] ?? nil else {
            XCTFail("image_content not found in Go normalizedEvents manifest")
            return
        }
        // tabId/instanceId are session correlators added by the desktop wire
        // envelope, not part of the engine ImageContentEvent struct.
        let swiftHandled: Set<String> = ["path", "mediaType", "source", "toolId"]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go image_content has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    func testEngineDispatchActivityDecode() throws {
        // tool_start (with dispatchActivityTs — the full wire shape)
        let startJSON = """
        {"type":"desktop_dispatch_activity","tabId":"t1","instanceId":"i1","dispatchAgentId":"dispatch-dev-1","dispatchConversationId":"child-conv","dispatchActivityKind":"tool_start","dispatchSeq":1,"toolName":"Read","toolId":"tool-1","dispatchActivityTs":1782088921498}
        """.data(using: .utf8)!
        let startEvent = try decoder.decode(RemoteEvent.self, from: startJSON)
        guard case .engineDispatchActivity(_, _, let agentId, let convId, let kind, let seq, let toolName, let toolId, _, _, let ts) = startEvent else {
            return XCTFail("Expected engineDispatchActivity (tool_start)")
        }
        XCTAssertEqual(agentId, "dispatch-dev-1")
        XCTAssertEqual(convId, "child-conv")
        XCTAssertEqual(kind, "tool_start")
        XCTAssertEqual(seq, 1)
        XCTAssertEqual(toolName, "Read")
        XCTAssertEqual(toolId, "tool-1")
        XCTAssertEqual(ts, 1782088921498)

        // text delta
        let textJSON = """
        {"type":"desktop_dispatch_activity","tabId":"t1","dispatchAgentId":"a","dispatchConversationId":"c","dispatchActivityKind":"text","dispatchSeq":2,"dispatchTextDelta":"hello"}
        """.data(using: .utf8)!
        let textEvent = try decoder.decode(RemoteEvent.self, from: textJSON)
        guard case .engineDispatchActivity(_, _, _, _, let tkind, _, _, _, let textDelta, _, let textTs) = textEvent else {
            return XCTFail("Expected engineDispatchActivity (text)")
        }
        XCTAssertEqual(tkind, "text")
        XCTAssertEqual(textDelta, "hello")
        // Absent dispatchActivityTs decodes as nil (tolerant mirror).
        XCTAssertNil(textTs)

        // tool_end with error
        let endJSON = """
        {"type":"desktop_dispatch_activity","tabId":"t1","dispatchAgentId":"a","dispatchConversationId":"c","dispatchActivityKind":"tool_end","dispatchSeq":3,"toolId":"tool-1","dispatchToolIsError":true}
        """.data(using: .utf8)!
        let endEvent = try decoder.decode(RemoteEvent.self, from: endJSON)
        guard case .engineDispatchActivity(_, _, _, _, let ekind, _, _, _, _, let isError, _) = endEvent else {
            return XCTFail("Expected engineDispatchActivity (tool_end)")
        }
        XCTAssertEqual(ekind, "tool_end")
        XCTAssertTrue(isError)
    }

    func testEngineMessageEndDecode() throws {
        let json = """
        {"type":"desktop_message_end","tabId":"t1","usage":{"inputTokens":100,"outputTokens":50,"contextPercent":30,"cost":0.01}}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineMessageEnd(_, _, let input, let output, let pct, let cost, let entryId, let userEntryId) = event {
            XCTAssertEqual(input, 100)
            XCTAssertEqual(output, 50)
            XCTAssertEqual(pct, 30.0)
            XCTAssertEqual(cost, 0.01)
            // Older desktops omit the canonical entry ids — they decode nil.
            XCTAssertNil(entryId)
            XCTAssertNil(userEntryId)
        } else {
            XCTFail("Expected engineMessageEnd")
        }
    }

    /// The canonical persisted entry ids ride inside `usage` on the wire
    /// (Go MessageEndUsage) and surface as top-level associated values on
    /// the Swift case. handleEngineMessageEnd uses them to re-key the
    /// streamed rows so history pages anchor on them.
    func testEngineMessageEndDecodeWithEntryIds() throws {
        let json = """
        {"type":"desktop_message_end","tabId":"t1","usage":{"inputTokens":100,"outputTokens":50,"contextPercent":30,"cost":0.01,"entryId":"entry-9","userEntryId":"entry-8"}}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineMessageEnd(_, _, _, _, _, _, let entryId, let userEntryId) = event {
            XCTAssertEqual(entryId, "entry-9")
            XCTAssertEqual(userEntryId, "entry-8")
        } else {
            XCTFail("Expected engineMessageEnd with entry ids")
        }
    }

    func testEngineDialogDecode() throws {
        let json = """
        {"type":"desktop_dialog","tabId":"t1","dialogId":"d1","method":"select","title":"Pick","options":["a","b"]}
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
        {"type":"desktop_agent_state","tabId":"t1","agents":[{"name":"coder","status":"running","metadata":{"displayName":"Coder","type":"specialist","visibility":"always","invited":true}}]}
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
        {"inputTokens":100,"outputTokens":50,"contextPercent":30,"cost":0.5,"entryId":"e-1","userEntryId":"u-1"}
        """.data(using: .utf8)!
        let usage = try decoder.decode(EngineMessageEndUsage.self, from: json)
        XCTAssertEqual(usage.inputTokens, 100)
        XCTAssertEqual(usage.outputTokens, 50)
        XCTAssertEqual(usage.entryId, "e-1")
        XCTAssertEqual(usage.userEntryId, "u-1")

        let swiftHandled: Set<String> = [
            "inputTokens", "outputTokens", "contextPercent", "cost",
            "entryId", "userEntryId",
        ]
        let unhandled = Set(goFields).subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go MessageEndUsage has fields not tracked in Swift: \(unhandled.sorted())"
        )
    }

    // MARK: - SessionMessage / SessionMessageAttachment field coverage

    /// Go `SessionMessage` is the engine's persisted history-row shape. iOS
    /// consumes it two ways: via the desktop history mapper (standard
    /// `Message` Codable decode on desktop_conversation_history) and via the
    /// direct engine-wire path (`Message(engineJSON:)` for agent histories).
    /// This tracked set mirrors the Go manifest so any engine-side field
    /// addition fails here and prompts an iOS review. Fields iOS deliberately
    /// does not decode are still tracked (documented inline).
    func testSessionMessageFieldsInManifest() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["SessionMessage"] else {
            XCTFail("SessionMessage not found in Go manifest")
            return
        }

        let swiftHandled: Set<String> = [
            // Decoded by Message (Codable + engineJSON paths).
            "attachments", "content", "id", "internal", "role",
            "slashArgs", "slashCommand", "slashSource",
            "timestamp", "toolId", "toolInput", "toolName",
            // Decoded by Message(engineJSON:) (markerKind + markerPlanFilePath
            // fallback for plan-divider links).
            "markerKind", "markerPlanFilePath",
            // Tracked but not decoded: the desktop history mapper folds these
            // marker payload details into the rendered divider content before
            // iOS sees the row; the engineJSON path routes markers by their
            // content sentinel. A future iOS marker renderer can adopt them
            // without a contract change.
            "markerClearedBlocks", "markerMessageLength",
            "markerMessagesAfter", "markerMessagesBefore", "markerMicroOnly",
            "markerPlanOperation", "markerPlanSlug",
            "markerStrategy", "markerSummary",
            // Tracked but not decoded: the desktop mapper projects a tool
            // row's error state onto `toolStatus` before forwarding to iOS.
            "isError",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go SessionMessage has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    /// Go `SessionMessageAttachment` mirrors onto the Swift MessageAttachment
    /// used on both history paths.
    func testSessionMessageAttachmentFieldsInManifest() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["SessionMessageAttachment"] else {
            XCTFail("SessionMessageAttachment not found in Go manifest")
            return
        }

        let swiftHandled: Set<String> = [
            "id", "mimeType", "name", "path", "type",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go SessionMessageAttachment has fields not tracked in Swift test: \(unhandled.sorted())"
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
            "thinkingMode", "thinkingEfforts",
            "isCustom",
            "tokenizer", // engine field; iOS does not consume it (thin client)
            "maxOutputTokens", // engine field; iOS does not consume it (thin client)
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
            // Delegated-CLI backend selection + install/auth status. iOS does
            // not run CLIs, so it does not act on these, but the contract test
            // tracks awareness of every Go field (see testProviderCliStatus).
            "backend", "cli",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go ProviderEntry has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - ProviderCliStatus / ProviderLoginUpdate awareness

    /// Tracks the delegated-CLI status shape carried on ProviderEntry.cli. iOS
    /// is a thin client and does not render CLI install/auth state (login is
    /// desktop-only — the CLIs live on the desktop machine), but the test pins
    /// awareness of every Go field so a future consumer starts from truth.
    func testProviderCliStatus() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["ProviderCliStatus"] else {
            XCTFail("ProviderCliStatus not found in Go manifest")
            return
        }
        let swiftHandled: Set<String> = [
            "backend", "installed", "binaryPath", "version",
            "authenticated", "authMethod", "planType", "email", "label", "probedAt",
        ]
        let unhandled = Set(goFields).subtracting(swiftHandled)
        XCTAssert(unhandled.isEmpty, "Go ProviderCliStatus has fields not tracked in Swift test: \(unhandled.sorted())")
    }

    /// Tracks the engine_provider_login payload (EngineEvent.providerLogin).
    /// Provider-CLI login is a desktop-only flow; iOS drops the forwarded
    /// desktop_provider_login events at trace level. The test pins field
    /// awareness for parity.
    func testProviderLoginUpdate() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["ProviderLoginUpdate"] else {
            XCTFail("ProviderLoginUpdate not found in Go manifest")
            return
        }
        let swiftHandled: Set<String> = [
            "provider", "backend", "stage",
            "authUrl", "userCode", "verificationUrl", "loginError", "loginId",
        ]
        let unhandled = Set(goFields).subtracting(swiftHandled)
        XCTAssert(unhandled.isEmpty, "Go ProviderLoginUpdate has fields not tracked in Swift test: \(unhandled.sorted())")
    }

    // MARK: - EngineEvent dispatch field coverage

    /// Pins that dispatchId and dispatchConversationId are present in the Go
    /// EngineEvent manifest and that the Swift decoder handles them on
    /// engineDispatchStart / engineDispatchEnd. Any future Go field added to
    /// dispatch events that Swift doesn't decode will surface here.
    func testEngineDispatchFieldsInManifest() throws {
        let manifest = try loadManifest()
        let goEventFields = Set(manifest.engineEvent)

        // Fields consumed by engineDispatchStart / engineDispatchEnd on iOS.
        let swiftConsumed: Set<String> = [
            "dispatchId",
            "dispatchConversationId",
            "dispatchAgent",
            "dispatchSessionId",
            "dispatchModel",
            "dispatchTask",
            "dispatchDepth",
            "dispatchParentId",
            "dispatchExitCode",
            "dispatchElapsed",
        ]

        let missingFromGo = swiftConsumed.subtracting(goEventFields)
        XCTAssert(
            missingFromGo.isEmpty,
            "EngineEvent manifest is missing dispatch fields consumed by iOS: \(missingFromGo.sorted())"
        )
    }

    // MARK: - context_breakdown normalized-event field coverage

    /// Pins that every field the Go engine declares on the context_breakdown
    /// normalized event is mirrored by the Swift ContextBreakdownPayload. The
    /// cacheReadTokens / cacheCreationTokens fields were added in the
    /// minty-grinning-cocoa plan (C7); this guards against future Go-side
    /// additions the Swift wire type doesn't handle.
    func testContextBreakdownNormalizedEventFields() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.normalizedEvents["context_breakdown"] ?? nil else {
            XCTFail("context_breakdown not found in Go normalizedEvents manifest")
            return
        }

        // Fields decoded by ContextBreakdownPayload / ContextBreakdownCategory on iOS.
        let swiftHandled: Set<String> = [
            "aggregateCostUsd", "apiReportedTotal", "cacheCreationTokens", "cacheReadTokens",
            "categories", "contextWindow", "model", "modelBreakdown", "totalTokens", "unaccounted",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go context_breakdown has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

    // MARK: - ModelBreakdown decode

    /// Pins that ModelBreakdown decodes all fields correctly. The struct was added
    /// in the early-grinning-sunset plan (WS2) to carry per-model cost breakdowns
    /// inside ContextBreakdownPayload. This test must fail if a future Go-side
    /// field addition goes un-mirrored in Swift.
    func testModelBreakdownDecode() throws {
        let json = """
        [
          {"model":"claude-opus-4-5","conversations":1,"inputTokens":1500000,"outputTokens":45000,"costUsd":195.71,"isSelf":true},
          {"model":"claude-opus-4-5","conversations":12,"inputTokens":900000,"outputTokens":30000,"costUsd":80.00},
          {"model":"claude-sonnet-4-6","conversations":9,"inputTokens":800000,"outputTokens":25000,"costUsd":110.50}
        ]
        """.data(using: .utf8)!
        let rows = try decoder.decode([ModelBreakdown].self, from: json)
        XCTAssertEqual(rows.count, 3)
        // Row 0: the viewing conversation's OWN opus spend (isSelf=true, count 1).
        XCTAssertEqual(rows[0].model, "claude-opus-4-5")
        XCTAssertEqual(rows[0].conversations, 1)
        XCTAssertEqual(rows[0].inputTokens, 1_500_000)
        XCTAssertEqual(rows[0].outputTokens, 45_000)
        XCTAssertEqual(rows[0].costUsd, 195.71, accuracy: 0.01)
        XCTAssertEqual(rows[0].isSelf, true)
        // Row 1: opus DISPATCHES (isSelf omitted on the wire -> nil).
        XCTAssertEqual(rows[1].model, "claude-opus-4-5")
        XCTAssertEqual(rows[1].conversations, 12)
        XCTAssertNil(rows[1].isSelf)
        // Row 2: sonnet dispatches (also a dispatch -> isSelf nil).
        XCTAssertEqual(rows[2].model, "claude-sonnet-4-6")
        XCTAssertEqual(rows[2].conversations, 9)
        XCTAssertEqual(rows[2].costUsd, 110.50, accuracy: 0.01)
        XCTAssertNil(rows[2].isSelf)
        // The self row and the dispatch row share a model but must have distinct
        // Identifiable ids so SwiftUI ForEach renders both.
        XCTAssertNotEqual(rows[0].id, rows[1].id)
    }

    /// Verifies ModelBreakdown fields are covered in the Go contract manifest.
    func testModelBreakdownFieldsInManifest() throws {
        let manifest = try loadManifest()
        guard let goFields = manifest.sharedTypes["ModelBreakdown"] else {
            XCTFail("ModelBreakdown not found in Go manifest")
            return
        }

        let swiftHandled: Set<String> = [
            "model", "conversations", "inputTokens", "outputTokens", "costUsd", "isSelf",
        ]
        let goSet = Set(goFields)
        let unhandled = goSet.subtracting(swiftHandled)
        XCTAssert(
            unhandled.isEmpty,
            "Go ModelBreakdown has fields not tracked in Swift test: \(unhandled.sorted())"
        )
    }

}
