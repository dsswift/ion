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
        {"type":"engine_tool_update","tabId":"t1","instanceId":"i1"}
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
        {"type":"engine_tool_update","tabId":"t1"}
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
        {"type":"engine_tool_complete","tabId":"t1","instanceId":"i1"}
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
        {"type":"engine_tool_complete","tabId":"t1"}
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
        {"type":"engine_schedule_fired","tabId":"t1","instanceId":"i1"}
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
        {"type":"engine_schedule_fired","tabId":"t1"}
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
        {"type":"engine_llm_call","tabId":"t1","instanceId":"i1"}
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
        {"type":"engine_llm_call","tabId":"t1"}
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
        {"type":"engine_dispatch_start","tabId":"t1","instanceId":"i1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchStart(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Expected engineDispatchStart, got \(event)")
        }
    }

    func testRoundTripEngineDispatchStart() throws {
        let original = RemoteEvent.engineDispatchStart(tabId: "t1", instanceId: "i1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineDispatchStart(let tabId, let instanceId) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
        } else {
            XCTFail("Round-trip engineDispatchStart failed")
        }
    }

    func testDecodeEngineDispatchStartWithoutInstanceId() throws {
        let json = """
        {"type":"engine_dispatch_start","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineDispatchStart(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected engineDispatchStart, got \(event)")
        }
    }
}
