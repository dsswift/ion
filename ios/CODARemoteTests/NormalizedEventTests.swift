import XCTest
@testable import CODARemote

final class NormalizedEventTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Helper

    /// Minimal valid RemoteTabState JSON matching the wire format.
    private var sampleTabJSON: String {
        """
        {"id":"t1","title":"Tab 1","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"ask","permissionQueue":[],"lastMessage":null,"contextTokens":null}
        """
    }

    // MARK: - Decode RemoteEvent

    func testDecodeSnapshot() throws {
        let json = """
        {"type":"snapshot","tabs":[\(sampleTabJSON)]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs) = event {
            XCTAssertEqual(tabs.count, 1)
            XCTAssertEqual(tabs[0].id, "t1")
            XCTAssertEqual(tabs[0].title, "Tab 1")
            XCTAssertNil(tabs[0].customTitle)
            XCTAssertEqual(tabs[0].status, .idle)
            XCTAssertEqual(tabs[0].workingDirectory, "/tmp")
            XCTAssertEqual(tabs[0].permissionMode, .auto)
            XCTAssertTrue(tabs[0].permissionQueue.isEmpty)
            XCTAssertNil(tabs[0].lastMessage)
            XCTAssertNil(tabs[0].contextTokens)
        } else {
            XCTFail("Expected snapshot, got \(event)")
        }
    }

    func testDecodeTabCreated() throws {
        let json = """
        {"type":"tab_created","tab":\(sampleTabJSON)}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabCreated(let tab) = event {
            XCTAssertEqual(tab.id, "t1")
            XCTAssertEqual(tab.status, .idle)
        } else {
            XCTFail("Expected tabCreated, got \(event)")
        }
    }

    func testDecodeTabClosed() throws {
        let json = """
        {"type":"tab_closed","tabId":"t42"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabClosed(let tabId) = event {
            XCTAssertEqual(tabId, "t42")
        } else {
            XCTFail("Expected tabClosed, got \(event)")
        }
    }

    func testDecodeTabStatus() throws {
        let json = """
        {"type":"tab_status","tabId":"t1","status":"running"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabStatus(let tabId, let status) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(status, .running)
        } else {
            XCTFail("Expected tabStatus, got \(event)")
        }
    }

    func testDecodeTextChunk() throws {
        let json = """
        {"type":"text_chunk","tabId":"t1","text":"Hello world"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .textChunk(let tabId, let text) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(text, "Hello world")
        } else {
            XCTFail("Expected textChunk, got \(event)")
        }
    }

    func testDecodeToolCall() throws {
        let json = """
        {"type":"tool_call","tabId":"t1","toolName":"bash","toolId":"tool-abc"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .toolCall(let tabId, let toolName, let toolId) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(toolName, "bash")
            XCTAssertEqual(toolId, "tool-abc")
        } else {
            XCTFail("Expected toolCall, got \(event)")
        }
    }

    func testDecodeToolResult() throws {
        let json = """
        {"type":"tool_result","tabId":"t1","toolId":"tool-abc","content":"file created","isError":false}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .toolResult(let tabId, let toolId, let content, let isError) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(toolId, "tool-abc")
            XCTAssertEqual(content, "file created")
            XCTAssertFalse(isError)
        } else {
            XCTFail("Expected toolResult, got \(event)")
        }
    }

    func testDecodeToolResultWithError() throws {
        let json = """
        {"type":"tool_result","tabId":"t2","toolId":"tool-xyz","content":"permission denied","isError":true}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .toolResult(_, _, _, let isError) = event {
            XCTAssertTrue(isError)
        } else {
            XCTFail("Expected toolResult, got \(event)")
        }
    }

    func testDecodeTaskComplete() throws {
        let json = """
        {"type":"task_complete","tabId":"t1","result":"success","costUsd":0.0042}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .taskComplete(let tabId, let result, let costUsd) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(result, "success")
            XCTAssertEqual(costUsd, 0.0042, accuracy: 0.0001)
        } else {
            XCTFail("Expected taskComplete, got \(event)")
        }
    }

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

    func testDecodeError() throws {
        let json = """
        {"type":"error","tabId":"t1","message":"Something went wrong"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .error(let tabId, let message) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(message, "Something went wrong")
        } else {
            XCTFail("Expected error, got \(event)")
        }
    }

    // MARK: - Decode all TabStatus values

    func testDecodeAllTabStatusValues() throws {
        let statuses: [(String, TabStatus)] = [
            ("connecting", .connecting),
            ("idle", .idle),
            ("running", .running),
            ("completed", .completed),
            ("failed", .failed),
            ("dead", .dead),
        ]
        for (raw, expected) in statuses {
            let json = """
            {"type":"tab_status","tabId":"t1","status":"\(raw)"}
            """.data(using: .utf8)!
            let event = try decoder.decode(RemoteEvent.self, from: json)
            if case .tabStatus(_, let status) = event {
                XCTAssertEqual(status, expected, "Status mismatch for '\(raw)'")
            } else {
                XCTFail("Expected tabStatus for '\(raw)'")
            }
        }
    }

    // MARK: - Round-trip: encode then decode

    func testRoundTripSnapshot() throws {
        let tab = RemoteTabState(
            id: "rt1",
            title: "Round Trip",
            customTitle: "Custom",
            status: .running,
            workingDirectory: "/home/user",
            permissionMode: .auto,
            permissionQueue: [],
            lastMessage: "hi",
            contextTokens: 512
        )
        let original = RemoteEvent.snapshot(tabs: [tab], recentDirectories: ["/Users/test/project"])
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .snapshot(let tabs, let recentDirs) = decoded {
            XCTAssertEqual(recentDirs, ["/Users/test/project"])
            XCTAssertEqual(tabs.count, 1)
            XCTAssertEqual(tabs[0].id, "rt1")
            XCTAssertEqual(tabs[0].customTitle, "Custom")
            XCTAssertEqual(tabs[0].status, .running)
            XCTAssertEqual(tabs[0].permissionMode, .auto)
            XCTAssertEqual(tabs[0].lastMessage, "hi")
            XCTAssertEqual(tabs[0].contextTokens, 512)
        } else {
            XCTFail("Round-trip snapshot failed")
        }
    }

    func testRoundTripTextChunk() throws {
        let original = RemoteEvent.textChunk(tabId: "t5", text: "streaming text here")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .textChunk(let tabId, let text) = decoded {
            XCTAssertEqual(tabId, "t5")
            XCTAssertEqual(text, "streaming text here")
        } else {
            XCTFail("Round-trip textChunk failed")
        }
    }

    func testRoundTripToolResult() throws {
        let original = RemoteEvent.toolResult(tabId: "t3", toolId: "tid", content: "result data", isError: true)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .toolResult(let tabId, let toolId, let content, let isError) = decoded {
            XCTAssertEqual(tabId, "t3")
            XCTAssertEqual(toolId, "tid")
            XCTAssertEqual(content, "result data")
            XCTAssertTrue(isError)
        } else {
            XCTFail("Round-trip toolResult failed")
        }
    }

    func testRoundTripTaskComplete() throws {
        let original = RemoteEvent.taskComplete(tabId: "t7", result: "done", costUsd: 1.23)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .taskComplete(let tabId, let result, let costUsd) = decoded {
            XCTAssertEqual(tabId, "t7")
            XCTAssertEqual(result, "done")
            XCTAssertEqual(costUsd, 1.23, accuracy: 0.001)
        } else {
            XCTFail("Round-trip taskComplete failed")
        }
    }

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

    // MARK: - RemoteCommand encoding

    func testEncodeSync() throws {
        let cmd = RemoteCommand.sync
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "sync")
        // sync has no extra fields beyond type
        XCTAssertEqual(json.count, 1)
    }

    func testEncodePrompt() throws {
        let cmd = RemoteCommand.prompt(tabId: "t1", text: "What is this?")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "prompt")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["text"] as? String, "What is this?")
    }

    func testEncodeRespondPermission() throws {
        let cmd = RemoteCommand.respondPermission(tabId: "t2", questionId: "q5", optionId: "allow")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "respond_permission")
        XCTAssertEqual(json["tabId"] as? String, "t2")
        XCTAssertEqual(json["questionId"] as? String, "q5")
        XCTAssertEqual(json["optionId"] as? String, "allow")
    }

    func testEncodeCreateTab() throws {
        let cmd = RemoteCommand.createTab(workingDirectory: "/home/user/project")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "create_tab")
        XCTAssertEqual(json["workingDirectory"] as? String, "/home/user/project")
    }

    func testEncodeCreateTabWithNilDirectory() throws {
        let cmd = RemoteCommand.createTab(workingDirectory: nil)
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "create_tab")
        // workingDirectory should be absent (encodeIfPresent skips nil)
        XCTAssertNil(json["workingDirectory"])
    }

    func testEncodeCloseTab() throws {
        let cmd = RemoteCommand.closeTab(tabId: "t99")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "close_tab")
        XCTAssertEqual(json["tabId"] as? String, "t99")
    }

    func testEncodeCancel() throws {
        let cmd = RemoteCommand.cancel(tabId: "t3")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "cancel")
        XCTAssertEqual(json["tabId"] as? String, "t3")
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

    // MARK: - Command round-trip (encode then decode)

    func testCommandRoundTripSync() throws {
        let original = RemoteCommand.sync
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .sync = decoded {
            // pass
        } else {
            XCTFail("Round-trip sync failed")
        }
    }

    func testCommandRoundTripPrompt() throws {
        let original = RemoteCommand.prompt(tabId: "tab-1", text: "explain this code")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .prompt(let tabId, let text, _) = decoded {
            XCTAssertEqual(tabId, "tab-1")
            XCTAssertEqual(text, "explain this code")
        } else {
            XCTFail("Round-trip prompt failed")
        }
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

    func testCommandRoundTripCreateTab() throws {
        let original = RemoteCommand.createTab(workingDirectory: "/var/log")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .createTab(let wd) = decoded {
            XCTAssertEqual(wd, "/var/log")
        } else {
            XCTFail("Round-trip createTab failed")
        }
    }

    func testCommandRoundTripCloseTab() throws {
        let original = RemoteCommand.closeTab(tabId: "close-me")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .closeTab(let tabId) = decoded {
            XCTAssertEqual(tabId, "close-me")
        } else {
            XCTFail("Round-trip closeTab failed")
        }
    }

    func testCommandRoundTripCancel() throws {
        let original = RemoteCommand.cancel(tabId: "c1")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .cancel(let tabId) = decoded {
            XCTAssertEqual(tabId, "c1")
        } else {
            XCTFail("Round-trip cancel failed")
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

    // MARK: - Edge cases

    func testDecodeSnapshotWithMultipleTabs() throws {
        let tab2 = """
        {"id":"t2","title":"Tab 2","customTitle":"My Tab","status":"running","workingDirectory":"/home","permissionMode":"plan","permissionQueue":[],"lastMessage":"working...","contextTokens":1024}
        """
        let json = """
        {"type":"snapshot","tabs":[\(sampleTabJSON),\(tab2)]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs) = event {
            XCTAssertEqual(tabs.count, 2)
            XCTAssertEqual(tabs[1].id, "t2")
            XCTAssertEqual(tabs[1].customTitle, "My Tab")
            XCTAssertEqual(tabs[1].displayTitle, "My Tab")
            XCTAssertEqual(tabs[1].status, .running)
            XCTAssertEqual(tabs[1].permissionMode, .plan)
            XCTAssertEqual(tabs[1].lastMessage, "working...")
            XCTAssertEqual(tabs[1].contextTokens, 1024)
        } else {
            XCTFail("Expected snapshot with 2 tabs")
        }
    }

    func testDecodeSnapshotEmptyTabs() throws {
        let json = """
        {"type":"snapshot","tabs":[]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .snapshot(let tabs) = event {
            XCTAssertTrue(tabs.isEmpty)
        } else {
            XCTFail("Expected snapshot with empty tabs")
        }
    }

    func testDecodeInvalidTypeThrows() {
        let json = """
        {"type":"unknown_event","tabId":"t1"}
        """.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(RemoteEvent.self, from: json))
    }

    func testDecodeInvalidCommandTypeThrows() {
        let json = """
        {"type":"unknown_command"}
        """.data(using: .utf8)!
        XCTAssertThrowsError(try decoder.decode(RemoteCommand.self, from: json))
    }

    func testDisplayTitleFallsBackToTitle() {
        let tab = RemoteTabState(
            id: "t1",
            title: "Fallback Title",
            customTitle: nil,
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            permissionQueue: [],
            lastMessage: nil,
            contextTokens: nil
        )
        XCTAssertEqual(tab.displayTitle, "Fallback Title")
    }

    func testDisplayTitleUsesCustomWhenPresent() {
        let tab = RemoteTabState(
            id: "t1",
            title: "Default",
            customTitle: "Override",
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            permissionQueue: [],
            lastMessage: nil,
            contextTokens: nil
        )
        XCTAssertEqual(tab.displayTitle, "Override")
    }

    // MARK: - Terminal Event Decoding

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

    // MARK: - Terminal Event Round-trips

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

    // MARK: - Terminal Command Encoding

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

    // MARK: - Terminal Command Round-trips

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

    // MARK: - RemoteTabState with terminal fields

    func testDecodeRemoteTabStateWithTerminalFields() throws {
        let json = """
        {"id":"t1","title":"Terminal","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"ask","permissionQueue":[],"lastMessage":null,"contextTokens":null,"isTerminalOnly":true,"terminalInstances":[{"id":"i1","label":"zsh","kind":"user","readOnly":false,"cwd":"/tmp"}],"activeTerminalInstanceId":"i1"}
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

    // MARK: - renameTab command

    func testEncodeRenameTab() throws {
        let cmd = RemoteCommand.renameTab(tabId: "t1", customTitle: "My Tab")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "rename_tab")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["customTitle"] as? String, "My Tab")
    }

    func testEncodeRenameTabNullTitle() throws {
        let cmd = RemoteCommand.renameTab(tabId: "t1", customTitle: nil)
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "rename_tab")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertTrue(json["customTitle"] == nil || json["customTitle"] is NSNull)
    }

    func testCommandRoundTripRenameTab() throws {
        let original = RemoteCommand.renameTab(tabId: "t1", customTitle: "Custom Name")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .renameTab(let tabId, let customTitle) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(customTitle, "Custom Name")
        } else {
            XCTFail("Expected renameTab, got \(decoded)")
        }
    }

    func testCommandRoundTripRenameTabNullTitle() throws {
        let original = RemoteCommand.renameTab(tabId: "t1", customTitle: nil)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .renameTab(let tabId, let customTitle) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(customTitle)
        } else {
            XCTFail("Expected renameTab, got \(decoded)")
        }
    }
}
