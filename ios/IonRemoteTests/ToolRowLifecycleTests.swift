import XCTest
@testable import IonRemote

/// RC-21 / RC-22: tool-row lifecycle correctness.
/// - RC-21: a tool row stuck .running (dropped tool_end) is demoted to
///   .completed when the tab reaches a terminal state, so grouping stops
///   showing an eternal spinner.
/// - RC-22: a duplicate tool_start (reconnect replay) must not create a second
///   row with the same toolId.
@MainActor
final class ToolRowLifecycleTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String, status: TabStatus = .running) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: status,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    func testDuplicateToolStartDoesNotDuplicateRow() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        vm.handleEngineToolStart(tabId: "t", instanceId: nil, toolName: "Bash", toolId: "tool-1")
        vm.handleEngineToolStart(tabId: "t", instanceId: nil, toolName: "Bash", toolId: "tool-1") // replay

        let toolRows = vm.conversationMessages("t").filter { $0.toolId == "tool-1" }
        XCTAssertEqual(toolRows.count, 1, "a replayed tool_start must not create a duplicate row")
        XCTAssertEqual(toolRows.first?.toolStatus, .running)
    }

    func testLostToolEndResolvedOnTerminalStatus() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        vm.handleEngineToolStart(tabId: "t", instanceId: nil, toolName: "Bash", toolId: "tool-1")
        // tool_end never arrives; the tab goes terminal.
        vm.handleTabStatus(tabId: "t", status: .completed)

        let toolRow = vm.conversationMessages("t").first { $0.toolId == "tool-1" }
        XCTAssertEqual(toolRow?.toolStatus, .completed,
            "a running tool row must be demoted to completed on a terminal transition (no eternal spinner)")
    }

    func testLostToolEndResolvedOnTaskComplete() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        vm.handleEngineToolStart(tabId: "t", instanceId: nil, toolName: "Grep", toolId: "tool-2")
        vm.handleTaskComplete(tabId: "t")

        let toolRow = vm.conversationMessages("t").first { $0.toolId == "tool-2" }
        XCTAssertEqual(toolRow?.toolStatus, .completed,
            "handleTaskComplete must also finalize a stuck running tool row")
    }

    func testNormalToolEndStillCompletes() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")

        vm.handleEngineToolStart(tabId: "t", instanceId: nil, toolName: "Read", toolId: "tool-3")
        vm.handleEngineToolEnd(tabId: "t", instanceId: nil, toolId: "tool-3", result: "ok", isError: false)

        let toolRow = vm.conversationMessages("t").first { $0.toolId == "tool-3" }
        XCTAssertEqual(toolRow?.toolStatus, .completed)
        XCTAssertEqual(toolRow?.content, "ok")
    }
}
