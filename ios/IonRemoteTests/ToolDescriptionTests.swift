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

/// A running tool row's input streams in as `append` patches on its
/// `toolInput`, and the description reads the accumulated value.
@MainActor
final class ToolInputAccumulationTests: XCTestCase {

    private typealias T = TranscriptTestSupport

    private func openWithRunningTool(_ vm: SessionViewModel, toolId: String) {
        vm.tabs = [T.tab("t", status: .running)]
        var tool = T.row(toolId, .tool)
        tool.toolName = "Bash"
        tool.toolId = toolId
        tool.toolStatus = .running
        vm.handleTranscriptPage(T.page(tabId: "t", rows: [tool]))
    }

    func testPartialInputAccumulatesOnRunningRow() {
        let vm = SessionViewModel()
        openWithRunningTool(vm, toolId: "tool-1")

        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 1, change: .append(index: 0, id: "tool-1", field: .toolInput, text: #"{"command":"git "#)))
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 1, total: 1, change: .append(index: 0, id: "tool-1", field: .toolInput, text: #"status"}"#)))

        let row = vm.conversationMessages("t").first { $0.id == "tool-1" }
        XCTAssertEqual(row?.toolInput, #"{"command":"git status"}"#,
            "streamed input must be concatenated in order onto the tool row")
    }

    func testDescriptionVisibleAfterAccumulation() {
        let vm = SessionViewModel()
        openWithRunningTool(vm, toolId: "tool-2")
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 1, change: .append(index: 0, id: "tool-2", field: .toolInput, text: #"{"command":"ls -la"}"#)))

        let row = vm.conversationMessages("t").first { $0.id == "tool-2" }
        XCTAssertEqual(toolDescriptionText(name: row?.toolName, input: row?.toolInput), "ls -la",
            "toolDescriptionText on accumulated toolInput must return the Bash command")
    }

    func testRunningToolRowsAreTheActiveTools() {
        let vm = SessionViewModel()
        openWithRunningTool(vm, toolId: "tool-3")
        XCTAssertEqual(vm.activeTools["t"]?.keys.sorted(), ["tool-3"])

        var done = T.row("tool-3", .tool)
        done.toolName = "Bash"
        done.toolId = "tool-3"
        done.toolStatus = .completed
        vm.handleTranscriptPatch(T.patch(tabId: "t", baseRev: 0, total: 1, change: .splice(at: 0, deleteCount: 1, rows: [done])))
        XCTAssertNil(vm.activeTools["t"], "a finished tool row is no longer an active tool")
    }
}
