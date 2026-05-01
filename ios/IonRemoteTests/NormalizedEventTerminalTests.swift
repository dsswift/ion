import XCTest
@testable import IonRemote

/// Terminal events and commands: output, exit, instance lifecycle, snapshot,
/// terminal-specific RemoteTabState fields, plus the request_terminal_snapshot
/// command.
final class NormalizedEventTerminalTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// Minimal valid RemoteTabState JSON without terminal fields.
    private var sampleTabJSON: String {
        """
        {"id":"t1","title":"Tab 1","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null}
        """
    }

    // MARK: - Decode terminal events

    func testDecodeTerminalOutput() throws {
        let json = """
        {"type":"terminal_output","tabId":"t1","instanceId":"inst1","data":"hello\\r\\n"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .terminalOutput(let tabId, let instanceId, let data) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "inst1")
            XCTAssertEqual(data, "hello\r\n")
        } else {
            XCTFail("Expected terminalOutput, got \(event)")
        }
    }

    func testDecodeTerminalExit() throws {
        let json = """
        {"type":"terminal_exit","tabId":"t1","instanceId":"inst1","exitCode":0}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .terminalExit(let tabId, let instanceId, let exitCode) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "inst1")
            XCTAssertEqual(exitCode, 0)
        } else {
            XCTFail("Expected terminalExit, got \(event)")
        }
    }

    func testDecodeTerminalInstanceAdded() throws {
        let json = """
        {"type":"terminal_instance_added","tabId":"t1","instance":{"id":"inst2","label":"Shell","kind":"user","readOnly":false,"cwd":"/tmp"}}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .terminalInstanceAdded(let tabId, let instance) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instance.id, "inst2")
            XCTAssertEqual(instance.label, "Shell")
            XCTAssertEqual(instance.kind, "user")
            XCTAssertFalse(instance.readOnly)
            XCTAssertEqual(instance.cwd, "/tmp")
        } else {
            XCTFail("Expected terminalInstanceAdded, got \(event)")
        }
    }

    func testDecodeTerminalInstanceRemoved() throws {
        let json = """
        {"type":"terminal_instance_removed","tabId":"t1","instanceId":"inst2"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .terminalInstanceRemoved(let tabId, let instanceId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "inst2")
        } else {
            XCTFail("Expected terminalInstanceRemoved, got \(event)")
        }
    }

    func testDecodeTerminalSnapshot() throws {
        let json = """
        {"type":"terminal_snapshot","tabId":"t1","instances":[{"id":"inst1","label":"Shell","kind":"user","readOnly":false,"cwd":"/home"}],"activeInstanceId":"inst1","buffers":{"inst1":"scrollback data"}}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .terminalSnapshot(let tabId, let instances, let activeInstanceId, let buffers) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instances.count, 1)
            XCTAssertEqual(instances[0].id, "inst1")
            XCTAssertEqual(activeInstanceId, "inst1")
            XCTAssertEqual(buffers?["inst1"], "scrollback data")
        } else {
            XCTFail("Expected terminalSnapshot, got \(event)")
        }
    }

    func testDecodeTerminalSnapshotWithoutBuffers() throws {
        let json = """
        {"type":"terminal_snapshot","tabId":"t1","instances":[],"activeInstanceId":null}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .terminalSnapshot(_, let instances, let activeInstanceId, let buffers) = event {
            XCTAssertTrue(instances.isEmpty)
            XCTAssertNil(activeInstanceId)
            XCTAssertNil(buffers)
        } else {
            XCTFail("Expected terminalSnapshot, got \(event)")
        }
    }

    // MARK: - Round-trip terminal events

    func testRoundTripTerminalOutput() throws {
        let original = RemoteEvent.terminalOutput(tabId: "t1", instanceId: "i1", data: "test output")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .terminalOutput(let tabId, let instanceId, let text) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(text, "test output")
        } else {
            XCTFail("Round-trip terminalOutput failed")
        }
    }

    func testRoundTripTerminalExit() throws {
        let original = RemoteEvent.terminalExit(tabId: "t2", instanceId: "i2", exitCode: 127)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .terminalExit(let tabId, let instanceId, let exitCode) = decoded {
            XCTAssertEqual(tabId, "t2")
            XCTAssertEqual(instanceId, "i2")
            XCTAssertEqual(exitCode, 127)
        } else {
            XCTFail("Round-trip terminalExit failed")
        }
    }

    func testRoundTripTerminalSnapshot() throws {
        let inst = TerminalInstanceInfo(id: "i1", label: "zsh", kind: "user", readOnly: false, cwd: "/home")
        let original = RemoteEvent.terminalSnapshot(tabId: "t1", instances: [inst], activeInstanceId: "i1", buffers: ["i1": "data"])
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .terminalSnapshot(let tabId, let instances, let activeId, let buffers) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instances.count, 1)
            XCTAssertEqual(instances[0].label, "zsh")
            XCTAssertEqual(activeId, "i1")
            XCTAssertEqual(buffers?["i1"], "data")
        } else {
            XCTFail("Round-trip terminalSnapshot failed")
        }
    }

    // MARK: - Encode terminal commands

    func testEncodeCreateTerminalTab() throws {
        let cmd = RemoteCommand.createTerminalTab(workingDirectory: "/home/user")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "create_terminal_tab")
        XCTAssertEqual(json["workingDirectory"] as? String, "/home/user")
    }

    func testEncodeTerminalInput() throws {
        let cmd = RemoteCommand.terminalInput(tabId: "t1", instanceId: "i1", data: "ls\n")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "terminal_input")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["instanceId"] as? String, "i1")
        XCTAssertEqual(json["data"] as? String, "ls\n")
    }

    func testEncodeTerminalResize() throws {
        let cmd = RemoteCommand.terminalResize(tabId: "t1", instanceId: "i1", cols: 120, rows: 40)
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "terminal_resize")
        XCTAssertEqual(json["cols"] as? Int, 120)
        XCTAssertEqual(json["rows"] as? Int, 40)
    }

    func testEncodeTerminalAddInstance() throws {
        let cmd = RemoteCommand.terminalAddInstance(tabId: "t1")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "terminal_add_instance")
        XCTAssertEqual(json["tabId"] as? String, "t1")
    }

    func testEncodeTerminalRemoveInstance() throws {
        let cmd = RemoteCommand.terminalRemoveInstance(tabId: "t1", instanceId: "i2")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "terminal_remove_instance")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["instanceId"] as? String, "i2")
    }

    func testEncodeTerminalSelectInstance() throws {
        let cmd = RemoteCommand.terminalSelectInstance(tabId: "t1", instanceId: "i3")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "terminal_select_instance")
        XCTAssertEqual(json["instanceId"] as? String, "i3")
    }

    // MARK: - Round-trip terminal commands

    func testCommandRoundTripCreateTerminalTab() throws {
        let original = RemoteCommand.createTerminalTab(workingDirectory: "/var")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .createTerminalTab(let wd) = decoded {
            XCTAssertEqual(wd, "/var")
        } else {
            XCTFail("Round-trip createTerminalTab failed")
        }
    }

    func testCommandRoundTripTerminalInput() throws {
        let original = RemoteCommand.terminalInput(tabId: "t1", instanceId: "i1", data: "echo hi\n")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .terminalInput(let tabId, let instanceId, let text) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(text, "echo hi\n")
        } else {
            XCTFail("Round-trip terminalInput failed")
        }
    }

    func testCommandRoundTripTerminalResize() throws {
        let original = RemoteCommand.terminalResize(tabId: "t1", instanceId: "i1", cols: 80, rows: 24)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .terminalResize(let tabId, let instanceId, let cols, let rows) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(cols, 80)
            XCTAssertEqual(rows, 24)
        } else {
            XCTFail("Round-trip terminalResize failed")
        }
    }

    // MARK: - RemoteTabState terminal fields

    func testDecodeRemoteTabStateWithTerminalFields() throws {
        let json = """
        {"id":"t1","title":"Terminal","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null,"isTerminalOnly":true,"terminalInstances":[{"id":"i1","label":"zsh","kind":"user","readOnly":false,"cwd":"/tmp"}],"activeTerminalInstanceId":"i1"}
        """.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertEqual(tab.isTerminalOnly, true)
        XCTAssertEqual(tab.terminalInstances?.count, 1)
        XCTAssertEqual(tab.terminalInstances?[0].id, "i1")
        XCTAssertEqual(tab.activeTerminalInstanceId, "i1")
    }

    func testDecodeRemoteTabStateWithoutTerminalFields() throws {
        let json = sampleTabJSON.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertNil(tab.isTerminalOnly)
        XCTAssertNil(tab.terminalInstances)
        XCTAssertNil(tab.activeTerminalInstanceId)
    }

    // MARK: - requestTerminalSnapshot command

    func testEncodeRequestTerminalSnapshot() throws {
        let cmd = RemoteCommand.requestTerminalSnapshot(tabId: "tab-99")
        let data = try encoder.encode(cmd)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(dict["type"] as? String, "request_terminal_snapshot")
        XCTAssertEqual(dict["tabId"] as? String, "tab-99")
    }

    func testCommandRoundTripRequestTerminalSnapshot() throws {
        let original = RemoteCommand.requestTerminalSnapshot(tabId: "tab-99")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .requestTerminalSnapshot(let tabId) = decoded {
            XCTAssertEqual(tabId, "tab-99")
        } else {
            XCTFail("Expected requestTerminalSnapshot, got \(decoded)")
        }
    }
}
