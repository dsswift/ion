import XCTest
@testable import IonRemote

/// Codec tests for the engine_move_instance command and engine_instance_moved event.
/// Mirrors the style of NormalizedEventStreamTests.swift — pure encode/decode,
/// no network or MainActor required.
final class EngineMoveCodecTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - RemoteCommand encode

    func testEncodeEngineMoveInstance() throws {
        let cmd = RemoteCommand.engineMoveInstance(
            sourceTabId: "tab-a",
            instanceId: "inst-1",
            targetTabId: "tab-b"
        )
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "engine_move_instance")
        XCTAssertEqual(json["sourceTabId"] as? String, "tab-a")
        XCTAssertEqual(json["instanceId"] as? String, "inst-1")
        XCTAssertEqual(json["targetTabId"] as? String, "tab-b")
    }

    // MARK: - RemoteCommand decode

    func testDecodeEngineMoveInstance() throws {
        let json = """
        {
            "type": "engine_move_instance",
            "sourceTabId": "tab-a",
            "instanceId": "inst-1",
            "targetTabId": "tab-b"
        }
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)

        if case .engineMoveInstance(let sourceTabId, let instanceId, let targetTabId) = cmd {
            XCTAssertEqual(sourceTabId, "tab-a")
            XCTAssertEqual(instanceId, "inst-1")
            XCTAssertEqual(targetTabId, "tab-b")
        } else {
            XCTFail("Expected engineMoveInstance, got \(cmd)")
        }
    }

    // MARK: - RemoteCommand round-trip

    func testRoundTripEngineMoveInstance() throws {
        let original = RemoteCommand.engineMoveInstance(
            sourceTabId: "src-tab",
            instanceId: "inst-42",
            targetTabId: "dst-tab"
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)

        if case .engineMoveInstance(let sourceTabId, let instanceId, let targetTabId) = decoded {
            XCTAssertEqual(sourceTabId, "src-tab")
            XCTAssertEqual(instanceId, "inst-42")
            XCTAssertEqual(targetTabId, "dst-tab")
        } else {
            XCTFail("Round-trip engineMoveInstance failed, got \(decoded)")
        }
    }

    // MARK: - RemoteEvent decode

    func testDecodeEngineInstanceMovedEvent() throws {
        let json = """
        {
            "type": "engine_instance_moved",
            "sourceTabId": "tab-a",
            "instanceId": "inst-1",
            "targetTabId": "tab-b"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)

        if case .engineInstanceMoved(let sourceTabId, let instanceId, let targetTabId) = event {
            XCTAssertEqual(sourceTabId, "tab-a")
            XCTAssertEqual(instanceId, "inst-1")
            XCTAssertEqual(targetTabId, "tab-b")
        } else {
            XCTFail("Expected engineInstanceMoved, got \(event)")
        }
    }

    // MARK: - RemoteEvent encode

    func testEncodeEngineInstanceMovedEvent() throws {
        let event = RemoteEvent.engineInstanceMoved(
            sourceTabId: "tab-x",
            instanceId: "inst-9",
            targetTabId: "tab-y"
        )
        let data = try encoder.encode(event)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "engine_instance_moved")
        XCTAssertEqual(json["sourceTabId"] as? String, "tab-x")
        XCTAssertEqual(json["instanceId"] as? String, "inst-9")
        XCTAssertEqual(json["targetTabId"] as? String, "tab-y")
    }

    // MARK: - RemoteEvent round-trip

    func testRoundTripEngineInstanceMovedEvent() throws {
        let original = RemoteEvent.engineInstanceMoved(
            sourceTabId: "round-src",
            instanceId: "round-inst",
            targetTabId: "round-dst"
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)

        if case .engineInstanceMoved(let sourceTabId, let instanceId, let targetTabId) = decoded {
            XCTAssertEqual(sourceTabId, "round-src")
            XCTAssertEqual(instanceId, "round-inst")
            XCTAssertEqual(targetTabId, "round-dst")
        } else {
            XCTFail("Round-trip engineInstanceMoved failed, got \(decoded)")
        }
    }
}
