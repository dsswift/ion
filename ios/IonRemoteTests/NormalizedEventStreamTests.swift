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

    // MARK: - Prompt command

    func testEncodePrompt() throws {
        let cmd = RemoteCommand.prompt(tabId: "t1", text: "What is this?")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "prompt")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["text"] as? String, "What is this?")
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
}
