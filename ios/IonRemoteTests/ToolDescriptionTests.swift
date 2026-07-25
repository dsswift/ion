import XCTest
@testable import IonRemote

/// Tests for toolDescriptionText (tool-helpers port) and the streaming
/// toolInput accumulation handler introduced in SessionViewModel+EventHandlers.

// MARK: - toolDescriptionText

final class ToolDescriptionTextTests: XCTestCase {

    func testBashCommandExtracted() {
        let input = #"{"command":"git status"}"#
        XCTAssertEqual(toolDescriptionText(name: "Bash", input: input), "git status")
    }

    func testBashCdPrefixStripped() {
        let input = #"{"command":"cd /tmp/foo && ls -la"}"#
        XCTAssertEqual(toolDescriptionText(name: "Bash", input: input), "ls -la")
    }

    func testBashLongCommandTruncated() {
        let longCmd = String(repeating: "x", count: 80)
        let input = #"{"command":"\#(longCmd)"}"#
        let result = toolDescriptionText(name: "Bash", input: input)
        XCTAssertEqual(result?.count, 60)
    }

    func testReadFilePathExtracted() {
        let input = #"{"file_path":"/Users/josh/foo.swift"}"#
        XCTAssertEqual(toolDescriptionText(name: "Read", input: input), "/Users/josh/foo.swift")
    }

    func testEditFilePathExtracted() {
        let input = #"{"file_path":"/src/main.go","old_string":"x","new_string":"y"}"#
        XCTAssertEqual(toolDescriptionText(name: "Edit", input: input), "/src/main.go")
    }

    func testWriteFilePathExtracted() {
        let input = #"{"file_path":"/out.txt","content":"hello"}"#
        XCTAssertEqual(toolDescriptionText(name: "Write", input: input), "/out.txt")
    }

    func testGlobPatternExtracted() {
        let input = #"{"pattern":"**/*.ts","path":"/src"}"#
        XCTAssertEqual(toolDescriptionText(name: "Glob", input: input), "**/*.ts")
    }

    func testGrepPatternExtracted() {
        let input = #"{"pattern":"func main","path":"."}"#
        XCTAssertEqual(toolDescriptionText(name: "Grep", input: input), "func main")
    }

    func testWebSearchQueryExtracted() {
        let input = #"{"query":"swift async await"}"#
        XCTAssertEqual(toolDescriptionText(name: "WebSearch", input: input), "swift async await")
    }

    func testWebSearchSearchQueryFallback() {
        let input = #"{"search_query":"swift generics"}"#
        XCTAssertEqual(toolDescriptionText(name: "WebSearch", input: input), "swift generics")
    }

    func testWebFetchUrlExtracted() {
        let input = #"{"url":"https://example.com/api"}"#
        XCTAssertEqual(toolDescriptionText(name: "WebFetch", input: input), "https://example.com/api")
    }

    func testAgentDescriptionExtracted() {
        let input = #"{"description":"Locate the auth bug","prompt":"find the bug"}"#
        XCTAssertEqual(toolDescriptionText(name: "Agent", input: input), "Locate the auth bug")
    }

    func testAgentPromptFallback() {
        let input = #"{"prompt":"fix the issue"}"#
        XCTAssertEqual(toolDescriptionText(name: "Agent", input: input), "fix the issue")
    }

    func testUnknownToolReturnsNil() {
        let input = #"{"command":"echo hi"}"#
        XCTAssertNil(toolDescriptionText(name: "UnknownTool", input: input))
    }

    func testNilNameReturnsNil() {
        XCTAssertNil(toolDescriptionText(name: nil, input: #"{"command":"ls"}"#))
    }

    func testNilInputReturnsNil() {
        XCTAssertNil(toolDescriptionText(name: "Bash", input: nil))
    }

    func testEmptyInputReturnsNil() {
        XCTAssertNil(toolDescriptionText(name: "Bash", input: ""))
    }

    func testMalformedJsonReturnsNil() {
        XCTAssertNil(toolDescriptionText(name: "Bash", input: "not json"))
    }

    func testMissingFieldReturnsNil() {
        // Bash input with no "command" key
        let input = #"{"args":["ls"]}"#
        XCTAssertNil(toolDescriptionText(name: "Bash", input: input))
    }
}

// MARK: - toolInput streaming accumulation

@MainActor
final class ToolInputAccumulationTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: .running,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    func testPartialInputAccumulatesOnRunningRow() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        vm.handleEngineToolStart(tabId: "t", instanceId: nil, toolName: "Bash", toolId: "tool-1")

        // Simulate two desktop_tool_update chunks arriving
        vm.handleEngineToolUpdate(tabId: "t", toolId: "tool-1", partialInput: #"{"command":"git "#)
        vm.handleEngineToolUpdate(tabId: "t", toolId: "tool-1", partialInput: #"status"}"#)

        let row = vm.conversationMessages("t").first { $0.id == "tool-1" }
        XCTAssertEqual(row?.toolInput, #"{"command":"git status"}"#,
            "partialInput chunks must be concatenated in order onto the tool row")
    }

    func testAccumulationIgnoresMissingRow() {
        // toolId that was never started — must not crash or leave spurious state.
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        vm.handleEngineToolUpdate(tabId: "t", toolId: "ghost-tool", partialInput: "chunk")
        XCTAssertTrue(vm.conversationMessages("t").isEmpty)
    }

    func testDescriptionVisibleAfterAccumulation() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        vm.handleEngineToolStart(tabId: "t", instanceId: nil, toolName: "Bash", toolId: "tool-2")
        vm.handleEngineToolUpdate(tabId: "t", toolId: "tool-2", partialInput: #"{"command":"ls -la"}"#)

        let row = vm.conversationMessages("t").first { $0.id == "tool-2" }
        let desc = toolDescriptionText(name: row?.toolName, input: row?.toolInput)
        XCTAssertEqual(desc, "ls -la",
            "toolDescriptionText on accumulated toolInput must return the Bash command")
    }
}
