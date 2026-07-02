import XCTest
@testable import IonRemote

/// Decode + round-trip tests for the 5 engine event types added to
/// eliminate the 123 decode-errors/session diagnostic finding:
///   - engine_tool_update
///   - engine_tool_complete
///   - engine_schedule_fired
///   - engine_llm_call
///   - engine_dispatch_start
///
/// All five share the same (tabId, instanceId?) shape. Each event
/// gets a decode test, a round-trip test, and a without-instanceId
/// decode test.
final class NormalizedEventNewEngineTypesTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - engine_tool_update

    func testDecodeEngineToolUpdate() throws {
        let json = """
        {"type":"desktop_tool_update","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolUpdate(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineToolUpdate, got \(event)")
        }
    }

    func testRoundTripEngineToolUpdate() throws {
        let original = RemoteEvent.engineToolUpdate(tabId: "t1", instanceId: "i1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineToolUpdate(let tabId, let instanceId) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Round-trip engineToolUpdate failed")
        }
    }

    func testDecodeEngineToolUpdateWithoutInstanceId() throws {
        let json = """
        {"type":"desktop_tool_update","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolUpdate(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected engineToolUpdate, got \(event)")
        }
    }

    // MARK: - engine_tool_complete

    func testDecodeEngineToolComplete() throws {
        let json = """
        {"type":"desktop_tool_complete","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolComplete(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineToolComplete, got \(event)")
        }
    }

    func testRoundTripEngineToolComplete() throws {
        let original = RemoteEvent.engineToolComplete(tabId: "t1", instanceId: "i1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineToolComplete(let tabId, let instanceId) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Round-trip engineToolComplete failed")
        }
    }

    func testDecodeEngineToolCompleteWithoutInstanceId() throws {
        let json = """
        {"type":"desktop_tool_complete","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineToolComplete(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected engineToolComplete, got \(event)")
        }
    }

    // MARK: - engine_schedule_fired

    func testDecodeEngineScheduleFired() throws {
        let json = """
        {"type":"desktop_schedule_fired","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineScheduleFired(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineScheduleFired, got \(event)")
        }
    }

    func testRoundTripEngineScheduleFired() throws {
        let original = RemoteEvent.engineScheduleFired(tabId: "t1", instanceId: "i1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineScheduleFired(let tabId, let instanceId) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Round-trip engineScheduleFired failed")
        }
    }

    func testDecodeEngineScheduleFiredWithoutInstanceId() throws {
        let json = """
        {"type":"desktop_schedule_fired","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineScheduleFired(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected engineScheduleFired, got \(event)")
        }
    }

    // MARK: - engine_llm_call

    func testDecodeEngineLlmCall() throws {
        let json = """
        {"type":"desktop_llm_call","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineLlmCall(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineLlmCall, got \(event)")
        }
    }

    func testRoundTripEngineLlmCall() throws {
        let original = RemoteEvent.engineLlmCall(tabId: "t1", instanceId: "i1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineLlmCall(let tabId, let instanceId) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Round-trip engineLlmCall failed")
        }
    }

    func testDecodeEngineLlmCallWithoutInstanceId() throws {
        let json = """
        {"type":"desktop_llm_call","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineLlmCall(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected engineLlmCall, got \(event)")
        }
    }

    // MARK: - engine_dispatch_start

    func testDecodeEngineDispatchStart() throws {
        let json = """
        {"type":"desktop_dispatch_start","tabId":"t1","instanceId":"i1","dispatchAgent":"agent-a","dispatchSessionId":"sess-1","dispatchModel":"opus","dispatchTask":"do stuff","dispatchDepth":1,"dispatchParentId":"parent-x","dispatchId":"id-1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchStart(let tabId, let instanceId, let agent, let sessionId, let model, let task, let depth, let parentId, let dispatchId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(agent, "agent-a")
            XCTAssertEqual(sessionId, "sess-1")
            XCTAssertEqual(model, "opus")
            XCTAssertEqual(task, "do stuff")
            XCTAssertEqual(depth, 1)
            XCTAssertEqual(parentId, "parent-x")
            XCTAssertEqual(dispatchId, "id-1")
        } else {
            XCTFail("Expected engineDispatchStart, got \(event)")
        }
    }

    func testRoundTripEngineDispatchStart() throws {
        let original = RemoteEvent.engineDispatchStart(tabId: "t1", instanceId: "i1", dispatchAgent: "agent-b", dispatchSessionId: "sess-2", dispatchModel: "sonnet", dispatchTask: "review", dispatchDepth: 2, dispatchParentId: "p-123", dispatchId: "id-2")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineDispatchStart(let tabId, let instanceId, let agent, let sessionId, let model, let task, let depth, let parentId, let dispatchId) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(agent, "agent-b")
            XCTAssertEqual(sessionId, "sess-2")
            XCTAssertEqual(model, "sonnet")
            XCTAssertEqual(task, "review")
            XCTAssertEqual(depth, 2)
            XCTAssertEqual(parentId, "p-123")
            XCTAssertEqual(dispatchId, "id-2")
        } else {
            XCTFail("Round-trip engineDispatchStart failed")
        }
    }

    func testDecodeEngineDispatchStartWithoutInstanceId() throws {
        let json = """
        {"type":"desktop_dispatch_start","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchStart(let tabId, let instanceId, let agent, _, _, _, let depth, let parentId, _) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
            XCTAssertEqual(agent, "")
            XCTAssertEqual(depth, 0)
            XCTAssertEqual(parentId, "")
        } else {
            XCTFail("Expected engineDispatchStart, got \(event)")
        }
    }

    // MARK: - engine_dispatch_end

    func testDecodeEngineDispatchEnd() throws {
        let json = """
        {"type":"desktop_dispatch_end","tabId":"t1","instanceId":"i1","dispatchAgent":"agent-a","dispatchDepth":1,"dispatchParentId":"","dispatchExitCode":0,"dispatchElapsed":2.5}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchEnd(let tabId, let instanceId, let agent, let depth, let parentId, let exitCode, let elapsed, _, _) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(agent, "agent-a")
            XCTAssertEqual(depth, 1)
            XCTAssertEqual(parentId, "")
            XCTAssertEqual(exitCode, 0)
            XCTAssertEqual(elapsed, 2.5, accuracy: 0.01)
        } else {
            XCTFail("Expected engineDispatchEnd, got \(event)")
        }
    }

    // MARK: - engine_export

    func testDecodeEngineExport() throws {
        let json = """
        {"type":"desktop_export","tabId":"t1","instanceId":"i1","message":"# Conversation\\n\\nHello world","exportFormat":"markdown"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .engineExport(let tabId, let instanceId, let message, let exportFormat) = event else {
            XCTFail("Expected engineExport, got \(event)")
            return
        }
        XCTAssertEqual(tabId, "t1")
        XCTAssertEqual(instanceId, "i1")
        XCTAssertEqual(message, "# Conversation\n\nHello world")
        XCTAssertEqual(exportFormat, "markdown")
    }

    func testRoundTripEngineExport() throws {
        // Encode -> decode the same event back. The payload may carry
        // arbitrary markdown / JSON / HTML; we want the round-trip to
        // preserve it byte-for-byte, including the export format.
        let payload = "{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
        let original: RemoteEvent = .engineExport(
            tabId: "t1",
            instanceId: nil,
            message: payload,
            exportFormat: "json"
        )
        let encoded = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: encoded)
        guard case .engineExport(let tabId, let instanceId, let message, let exportFormat) = decoded else {
            XCTFail("Round-trip engineExport failed")
            return
        }
        XCTAssertEqual(tabId, "t1")
        XCTAssertNil(instanceId)
        XCTAssertEqual(message, payload)
        XCTAssertEqual(exportFormat, "json")
    }

    func testDecodeEngineExportWithoutInstanceId() throws {
        let json = """
        {"type":"desktop_export","tabId":"t1","message":"plain text"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .engineExport(let tabId, let instanceId, let message, let exportFormat) = event else {
            XCTFail("Expected engineExport, got \(event)")
            return
        }
        XCTAssertEqual(tabId, "t1")
        XCTAssertNil(instanceId)
        XCTAssertEqual(message, "plain text")
        // exportFormat absent in the JSON (legacy engine) decodes to nil.
        XCTAssertNil(exportFormat)
    }
}
