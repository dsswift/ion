import XCTest
@testable import IonRemote

/// Permission events: requests, resolutions, mode changes, and responses.
final class NormalizedEventPermissionTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Decode

    func testDecodePermissionRequest() throws {
        let json = """
        {"type":"permission_request","tabId":"t1","questionId":"q1","toolName":"bash","toolInput":{"command":"rm -rf /"},"options":[{"id":"allow","label":"Allow","kind":"approve"},{"id":"deny","label":"Deny","kind":"reject"}]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .permissionRequest(let tabId, let questionId, let toolName, let toolInput, let options) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(questionId, "q1")
            XCTAssertEqual(toolName, "bash")
            XCTAssertNotNil(toolInput)
            XCTAssertEqual(toolInput?["command"]?.value as? String, "rm -rf /")
            XCTAssertEqual(options.count, 2)
            XCTAssertEqual(options[0].id, "allow")
            XCTAssertEqual(options[0].label, "Allow")
            XCTAssertEqual(options[0].kind, "approve")
            XCTAssertEqual(options[1].id, "deny")
        } else {
            XCTFail("Expected permissionRequest, got \(event)")
        }
    }

    func testDecodePermissionRequestWithNullToolInput() throws {
        let json = """
        {"type":"permission_request","tabId":"t1","questionId":"q2","toolName":"read","toolInput":null,"options":[{"id":"ok","label":"OK","kind":null}]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .permissionRequest(_, _, _, let toolInput, let options) = event {
            XCTAssertNil(toolInput)
            XCTAssertEqual(options.count, 1)
            XCTAssertNil(options[0].kind)
        } else {
            XCTFail("Expected permissionRequest, got \(event)")
        }
    }

    func testDecodePermissionResolved() throws {
        let json = """
        {"type":"permission_resolved","tabId":"t1","questionId":"q1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .permissionResolved(let tabId, let questionId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(questionId, "q1")
        } else {
            XCTFail("Expected permissionResolved, got \(event)")
        }
    }

    // MARK: - Round-trip

    func testRoundTripPermissionRequest() throws {
        let option = PermissionOption(id: "yes", label: "Yes", kind: "approve")
        let original = RemoteEvent.permissionRequest(
            tabId: "t1",
            questionId: "q99",
            toolName: "write",
            toolInput: ["path": AnyCodable("/tmp/foo")],
            options: [option]
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .permissionRequest(let tabId, let questionId, let toolName, let toolInput, let options) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(questionId, "q99")
            XCTAssertEqual(toolName, "write")
            XCTAssertEqual(toolInput?["path"]?.value as? String, "/tmp/foo")
            XCTAssertEqual(options.count, 1)
            XCTAssertEqual(options[0].id, "yes")
        } else {
            XCTFail("Round-trip permissionRequest failed")
        }
    }

    // MARK: - Permission commands

    func testEncodeRespondPermission() throws {
        let cmd = RemoteCommand.respondPermission(tabId: "t2", questionId: "q5", optionId: "allow")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "respond_permission")
        XCTAssertEqual(json["tabId"] as? String, "t2")
        XCTAssertEqual(json["questionId"] as? String, "q5")
        XCTAssertEqual(json["optionId"] as? String, "allow")
    }

    func testEncodeSetPermissionMode() throws {
        let cmd = RemoteCommand.setPermissionMode(tabId: "t1", mode: .plan)
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "set_permission_mode")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["mode"] as? String, "plan")
    }

    func testEncodeSetPermissionModeAuto() throws {
        let cmd = RemoteCommand.setPermissionMode(tabId: "t2", mode: .auto)
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["mode"] as? String, "auto")
    }

    func testCommandRoundTripRespondPermission() throws {
        let original = RemoteCommand.respondPermission(tabId: "t1", questionId: "q1", optionId: "deny")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .respondPermission(let tabId, let questionId, let optionId) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(questionId, "q1")
            XCTAssertEqual(optionId, "deny")
        } else {
            XCTFail("Round-trip respondPermission failed")
        }
    }

    func testCommandRoundTripSetPermissionMode() throws {
        let original = RemoteCommand.setPermissionMode(tabId: "t1", mode: .auto)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .setPermissionMode(let tabId, let mode) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(mode, .auto)
        } else {
            XCTFail("Round-trip setPermissionMode failed")
        }
    }
}
