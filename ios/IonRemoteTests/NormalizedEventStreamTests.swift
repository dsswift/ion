import XCTest
@testable import IonRemote

/// Streaming + conversation events: text chunks, tool calls/results, task
/// completion, error events, and the `prompt` command.
final class NormalizedEventStreamTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Decode

    func testDecodeTextChunk() throws {
        let json = """
        {"type":"desktop_text_chunk","tabId":"t1","text":"Hello world"}
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
        {"type":"desktop_tool_call","tabId":"t1","toolName":"bash","toolId":"tool-abc"}
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
        {"type":"desktop_tool_result","tabId":"t1","toolId":"tool-abc","content":"file created","isError":false}
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
        {"type":"desktop_tool_result","tabId":"t2","toolId":"tool-xyz","content":"permission denied","isError":true}
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
        {"type":"desktop_task_complete","tabId":"t1","result":"success","costUsd":0.0042,"durationMs":62007,"reason":"max_turns"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .taskComplete(let tabId, let result, let costUsd, let durationMs, let reason) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(result, "success")
            XCTAssertEqual(costUsd, 0.0042, accuracy: 0.0001)
            XCTAssertEqual(durationMs, 62_007)
            XCTAssertEqual(reason, .maxTurns)
        } else {
            XCTFail("Expected taskComplete, got \(event)")
        }
    }

    func testDecodeTaskCompleteCompatibility() throws {
        let absentJSON = """
        {"type":"desktop_task_complete","tabId":"t1","result":"done","costUsd":0}
        """.data(using: .utf8)!
        if case .taskComplete(_, _, _, let durationMs, let reason) = try decoder.decode(RemoteEvent.self, from: absentJSON) {
            XCTAssertNil(durationMs)
            XCTAssertNil(reason)
        } else {
            XCTFail("Expected taskComplete with absent reason")
        }

        let unknownJSON = """
        {"type":"desktop_task_complete","tabId":"t1","result":"done","costUsd":0,"reason":"future_reason"}
        """.data(using: .utf8)!
        if case .taskComplete(_, _, _, let durationMs, let reason) = try decoder.decode(RemoteEvent.self, from: unknownJSON) {
            XCTAssertNil(durationMs)
            XCTAssertEqual(reason, .unknown("future_reason"))
        } else {
            XCTFail("Expected taskComplete with unknown reason")
        }
    }

    func testDecodeError() throws {
        let json = """
        {"type":"desktop_error","tabId":"t1","message":"Something went wrong"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .error(let tabId, let message) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(message, "Something went wrong")
        } else {
            XCTFail("Expected error, got \(event)")
        }
    }

    // MARK: - Round-trip

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
        let original = RemoteEvent.taskComplete(tabId: "t7", result: "done", costUsd: 1.23, durationMs: 3_661_000, reason: .normal)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .taskComplete(let tabId, let result, let costUsd, let durationMs, let reason) = decoded {
            XCTAssertEqual(tabId, "t7")
            XCTAssertEqual(result, "done")
            XCTAssertEqual(costUsd, 1.23, accuracy: 0.001)
            XCTAssertEqual(durationMs, 3_661_000)
            XCTAssertEqual(reason, .normal)
        } else {
            XCTFail("Round-trip taskComplete failed")
        }
    }

    // MARK: - Prompt result

    func testDecodePromptResultAccepted() throws {
        let json = """
        {"type":"desktop_prompt_result","tabId":"t1","clientMsgId":"msg-abc","status":"accepted"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .promptResult(let tabId, let clientMsgId, let status, let error) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(clientMsgId, "msg-abc")
            XCTAssertEqual(status, "accepted")
            XCTAssertNil(error)
        } else {
            XCTFail("Expected promptResult, got \(event)")
        }
    }

    func testDecodePromptResultRejected() throws {
        let json = """
        {"type":"desktop_prompt_result","tabId":"t2","clientMsgId":"msg-xyz","status":"rejected","error":"no main window"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .promptResult(let tabId, let clientMsgId, let status, let error) = event {
            XCTAssertEqual(tabId, "t2")
            XCTAssertEqual(clientMsgId, "msg-xyz")
            XCTAssertEqual(status, "rejected")
            XCTAssertEqual(error, "no main window")
        } else {
            XCTFail("Expected promptResult, got \(event)")
        }
    }

    func testRoundTripPromptResult() throws {
        let original = RemoteEvent.promptResult(tabId: "t5", clientMsgId: "msg-rt", status: "rejected", error: "timeout")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .promptResult(let tabId, let clientMsgId, let status, let error) = decoded {
            XCTAssertEqual(tabId, "t5")
            XCTAssertEqual(clientMsgId, "msg-rt")
            XCTAssertEqual(status, "rejected")
            XCTAssertEqual(error, "timeout")
        } else {
            XCTFail("Round-trip promptResult failed")
        }
    }

    @MainActor
    func testPromptResultEventUsesFullDeliveryHandler() {
        let vm = SessionViewModel()
        vm.tabs = [RemoteTabState(
            id: "t-delivery", title: "Delivery", customTitle: nil, status: .connecting,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
        var optimistic = Message(id: "msg-delivery", role: .user, content: "hello", timestamp: 1)
        optimistic.deliveryState = .queued
        vm.setConversationMessages(tabId: "t-delivery", [optimistic])

        vm.handleEvent(.promptResult(
            tabId: "t-delivery", clientMsgId: "msg-delivery", status: "rejected", error: "desktop unavailable"
        ))

        guard case .rejected(let error)? = vm.conversationMessages("t-delivery").first?.deliveryState else {
            return XCTFail("rejected prompt result did not update delivery state")
        }
        XCTAssertEqual(error, "desktop unavailable")
        XCTAssertEqual(vm.tabs.first?.status, .idle)
        XCTAssertTrue(vm.toastMessages.contains { $0.style == .error && $0.title == "Message not delivered" })
    }

    @MainActor
    func testPromptResultAcceptedClearsDeliveryIndicator() {
        let vm = SessionViewModel()
        vm.tabs = [RemoteTabState(
            id: "t-accepted", title: "Accepted", customTitle: nil, status: .connecting,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
        var optimistic = Message(id: "msg-accepted", role: .user, content: "hello", timestamp: 1)
        optimistic.deliveryState = .queued
        vm.setConversationMessages(tabId: "t-accepted", [optimistic])

        vm.handleEvent(.promptResult(tabId: "t-accepted", clientMsgId: "msg-accepted", status: "accepted", error: nil))

        guard case .accepted? = vm.conversationMessages("t-accepted").first?.deliveryState else {
            return XCTFail("accepted prompt result did not update delivery state")
        }
        XCTAssertEqual(vm.tabs.first?.status, .connecting)
        XCTAssertTrue(vm.toastMessages.isEmpty)
    }

    // MARK: - Engine rewind result (rejection-only notice)

    /// The desktop's rewind is transactional and sends this event ONLY on
    /// refusal (unknown/foreign-branch/non-user target). Round-trips through
    /// JSON to lock in the CodingKeys.
    func testDecodeEngineRewindResult() throws {
        let json = """
        {"type":"desktop_engine_rewind_result","tabId":"t1","instanceId":"i1","status":"rejected","error":"entry is not a user turn on the current path"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineRewindResult(let tabId, let instanceId, let error) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(error, "entry is not a user turn on the current path")
        } else {
            XCTFail("Expected engineRewindResult, got \(event)")
        }
    }

    /// `error` is optional on the wire (the desktop always sends one today,
    /// but the decoder must not throw if a future desktop omits it).
    func testDecodeEngineRewindResultWithoutError() throws {
        let json = """
        {"type":"desktop_engine_rewind_result","tabId":"t1","instanceId":"i1","status":"rejected"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineRewindResult(let tabId, let instanceId, let error) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertNil(error)
        } else {
            XCTFail("Expected engineRewindResult, got \(event)")
        }
    }

    func testRoundTripEngineRewindResult() throws {
        let original = RemoteEvent.engineRewindResult(tabId: "t9", instanceId: "i9", error: "unknown entry")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineRewindResult(let tabId, let instanceId, let error) = decoded {
            XCTAssertEqual(tabId, "t9")
            XCTAssertEqual(instanceId, "i9")
            XCTAssertEqual(error, "unknown entry")
        } else {
            XCTFail("Round-trip engineRewindResult failed")
        }
    }

    /// Regression: a refused rewind previously produced ZERO feedback on iOS
    /// — the user tapped "Rewind", nothing visibly happened, and there was
    /// no toast, no log, nothing. This pins that a rejection notice now
    /// surfaces an error toast.
    @MainActor
    func testEngineRewindResultShowsErrorToast() {
        let vm = SessionViewModel()
        XCTAssertTrue(vm.toastMessages.isEmpty)

        vm.handleEvent(.engineRewindResult(tabId: "t-rw", instanceId: "i-rw", error: "entry is not a user turn"))

        XCTAssertTrue(vm.toastMessages.contains { $0.style == .error && $0.title == "Rewind not applied" })
    }


    func testEncodePrompt() throws {
        let cmd = RemoteCommand.prompt(tabId: "t1", text: "What is this?")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_prompt")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["text"] as? String, "What is this?")
    }

    func testCommandRoundTripPrompt() throws {
        let original = RemoteCommand.prompt(tabId: "tab-1", text: "explain this code")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .prompt(let tabId, let text, _, _, _, _, _) = decoded {
            XCTAssertEqual(tabId, "tab-1")
            XCTAssertEqual(text, "explain this code")
        } else {
            XCTFail("Round-trip prompt failed")
        }
    }
}
