import XCTest
@testable import IonRemote

/// Delivered background work: row decoding, grouping, compaction separation,
/// and the task lifecycle events.
final class BackgroundWorkTests: XCTestCase {
    private let work = BackgroundWorkMetadata(
        kind: "background_task_completion",
        deliveryMode: "wake",
        items: [BackgroundWorkItem(id: "bash-1", source: "bash", label: "npm test", status: "completed", exitCode: 0, elapsedMs: 800, outputPath: nil)],
        remainingTaskIds: []
    )

    private func makeMsg(id: String, role: MessageRole, content: String = "", backgroundWork: BackgroundWorkMetadata? = nil) -> Message {
        var message = Message(id: id, role: role, content: content, timestamp: 1.0)
        message.backgroundWork = backgroundWork
        return message
    }

    private func makeBashTaskMsg(id: String, taskId: String, command: String, status: String) -> Message {
        let item = BackgroundWorkItem(id: taskId, source: "bash", label: command, status: status, exitCode: status == "completed" ? 0 : 1, elapsedMs: nil, outputPath: nil)
        let metadata = BackgroundWorkMetadata(kind: "background_task_completion", deliveryMode: "event_only", items: [item], remainingTaskIds: nil)
        return makeMsg(id: id, role: .system, backgroundWork: metadata)
    }

    func testClassicAndUnifiedGroupingDropUnmatchedBackgroundWork() {
        let metadata = BackgroundWorkMetadata(kind: "agent", deliveryMode: "wake", items: [BackgroundWorkItem(id: "work-3", source: "agent", label: "agent", status: "completed", exitCode: 0, elapsedMs: nil, outputPath: nil)], remainingTaskIds: nil)
        let messages = [makeMsg(id: "u1", role: .user, content: "hi"), makeMsg(id: "bw1", role: .system, backgroundWork: metadata), makeMsg(id: "a1", role: .assistant, content: "reply")]
        for unified in [false, true] {
            let items = groupConversationItems(messages, unifiedTurnView: unified)
            XCTAssertFalse(items.contains { item in
                if case .system(let message) = item { return message.id == "bw1" }
                return false
            })
        }
    }

    func testBackgroundTaskMetadataDropsWhenNoToolMatches() {
        let messages = [makeMsg(id: "u1", role: .user, content: "hi"), makeBashTaskMsg(id: "bt1", taskId: "task-1", command: "npm test", status: "completed"), makeMsg(id: "a1", role: .assistant, content: "reply")]
        let items = groupConversationItems(messages, unifiedTurnView: false)
        XCTAssertFalse(items.contains { item in
            if case .system(let message) = item { return message.id == "bt1" }
            return false
        })
    }

    func testCompactionNotRoutedAsBackgroundWork() {
        let items = groupConversationItems([makeMsg(id: "c1", role: .system, content: "[Compaction] 50% reduced")], unifiedTurnView: false)
        guard case .compaction = items[0] else {
            return XCTFail("Expected .compaction, got \(items[0])")
        }
    }

    // MARK: - Turn-level active background summary

    func testActiveBackgroundSummaryCountsAsyncPendingTools() {
        var t1 = Message(id: "t1", role: .tool, content: "", timestamp: 1)
        t1.toolName = "Bash"
        t1.toolStatus = .asyncPending
        t1.backgroundTaskId = "bg-1"

        var t2 = Message(id: "t2", role: .tool, content: "", timestamp: 2)
        t2.toolName = "Bash"
        t2.toolStatus = .asyncPending
        t2.backgroundTaskId = "bg-2"

        var t3 = Message(id: "t3", role: .tool, content: "done", timestamp: 3)
        t3.toolName = "Read"
        t3.toolStatus = .completed

        let tools = [t1, t2, t3]
        let active = tools.filter { $0.backgroundTaskId != nil && $0.toolStatus == .asyncPending }
        XCTAssertEqual(active.count, 2, "only asyncPending tools with backgroundTaskId count")
    }

    func testActiveBackgroundSummaryZeroWhenNoAsync() {
        var t1 = Message(id: "t1", role: .tool, content: "done", timestamp: 1)
        t1.toolName = "Bash"
        t1.toolStatus = .completed
        t1.backgroundTaskId = "bg-1"

        let tools = [t1]
        let active = tools.filter { $0.backgroundTaskId != nil && $0.toolStatus == .asyncPending }
        XCTAssertEqual(active.count, 0, "completed tools do not count as active background")
    }

    // MARK: - Active task wire and lifecycle

    func testActiveTaskStatusSnapshotDecodes() throws {
        let json = #"{"label":"tab","state":"running","model":"m","contextPercent":0,"contextWindow":1,"activeBackgroundTasks":[{"taskId":"bg-1","command":"npm test","startedAt":123,"notifyOnComplete":false}]}"#.data(using: .utf8)!
        let fields = try JSONDecoder().decode(StatusFields.self, from: json)
        XCTAssertEqual(fields.activeBackgroundTasks, [
            BackgroundTaskState(taskId: "bg-1", command: "npm test", startedAt: 123, notifyOnComplete: false)
        ])
    }

    func testBackgroundTaskLifecycleMatchesDesktopWireShape() throws {
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()

        let started = try decoder.decode(RemoteEvent.self, from: #"{"type":"desktop_background_task_started","tabId":"tab-1","instanceId":"main","task":{"taskId":"bg-1","toolId":"tool-1","command":"sleep 10","startedAt":123,"notifyOnComplete":false}}"#.data(using: .utf8)!)
        guard case .engineBackgroundTaskStarted(_, _, let taskId, let toolId, let command, let startedAt, let notify) = started else {
            return XCTFail("expected started event")
        }
        XCTAssertEqual(taskId, "bg-1")
        // The originating tool-use id is the only key binding this task to its
        // transcript row before the tool result carrying backgroundTaskId
        // arrives. The case decoded the full BackgroundTaskState and then
        // flattened it into associated values that had no slot for toolId, so
        // the id was read off the wire and thrown away — and re-encoding
        // reproduced a payload missing it.
        XCTAssertEqual(toolId, "tool-1")
        XCTAssertEqual(command, "sleep 10")
        XCTAssertEqual(startedAt, 123)
        XCTAssertFalse(notify)
        let startedJSON = try JSONSerialization.jsonObject(with: encoder.encode(started)) as! [String: Any]
        XCTAssertNotNil(startedJSON["task"])
        XCTAssertEqual((startedJSON["task"] as? [String: Any])?["toolId"] as? String, "tool-1")
        XCTAssertNil(startedJSON["backgroundTaskStarted"])

        let terminal = try decoder.decode(RemoteEvent.self, from: #"{"type":"desktop_background_task_terminal","tabId":"tab-1","instanceId":"main","taskId":"bg-1","status":"stopped","exitCode":-1,"elapsedMs":50,"command":"sleep 10","outputPath":"/tmp/bg-1.out","tail":"stopped"}"#.data(using: .utf8)!)
        guard case .engineBackgroundTaskTerminal(_, _, let terminalId, let status, let exitCode, let elapsedMs, let terminalCommand, let outputPath, let tail) = terminal else {
            return XCTFail("expected terminal event")
        }
        XCTAssertEqual(terminalId, "bg-1")
        XCTAssertEqual(status, "stopped")
        XCTAssertEqual(exitCode, -1)
        XCTAssertEqual(elapsedMs, 50)
        XCTAssertEqual(terminalCommand, "sleep 10")
        XCTAssertEqual(outputPath, "/tmp/bg-1.out")
        XCTAssertEqual(tail, "stopped")
        let terminalJSON = try JSONSerialization.jsonObject(with: encoder.encode(terminal)) as! [String: Any]
        XCTAssertEqual(terminalJSON["taskId"] as? String, "bg-1")
        XCTAssertNil(terminalJSON["backgroundTaskTerminal"])

        let stopped = try decoder.decode(RemoteEvent.self, from: #"{"type":"desktop_session_work_stopped","tabId":"tab-1","instanceId":"main","scope":"all_work","cancelledRunId":"run-1","recalledDispatchIds":["dispatch-1"],"stoppedBackgroundTaskIds":["bg-1"],"killedAgentProcessCount":1}"#.data(using: .utf8)!)
        guard case .engineSessionWorkStopped(_, _, let scope, let cancelledRunId, let recalledDispatchIds, let stoppedTaskIds, let killedAgentProcessCount) = stopped else {
            return XCTFail("expected session work stopped event")
        }
        XCTAssertEqual(scope, "all_work")
        XCTAssertEqual(cancelledRunId, "run-1")
        XCTAssertEqual(recalledDispatchIds, ["dispatch-1"])
        XCTAssertEqual(stoppedTaskIds, ["bg-1"])
        XCTAssertEqual(killedAgentProcessCount, 1)
        let stoppedJSON = try JSONSerialization.jsonObject(with: encoder.encode(stopped)) as! [String: Any]
        XCTAssertEqual(stoppedJSON["scope"] as? String, "all_work")
        XCTAssertEqual(stoppedJSON["cancelledRunId"] as? String, "run-1")
        XCTAssertEqual(stoppedJSON["recalledDispatchIds"] as? [String], ["dispatch-1"])
        XCTAssertEqual(stoppedJSON["stoppedBackgroundTaskIds"] as? [String], ["bg-1"])
        XCTAssertEqual(stoppedJSON["killedAgentProcessCount"] as? Int, 1)
        XCTAssertNil(stoppedJSON["sessionWorkStopped"])
    }

    /// The terminal event settles the task list. The tool row's own status is
    /// the server's to change; it arrives on the transcript.
    @MainActor
    func testTerminalEventRemovesExactTaskAndLeavesRowsToTheTranscript() {
        let vm = SessionViewModel()
        vm.ensureMainInstance(tabId: "tab-1")
        var first = Message(id: "tool-1", role: .tool, content: "", timestamp: 1)
        first.backgroundTaskId = "bg-1"
        first.toolStatus = .asyncPending
        var second = Message(id: "tool-2", role: .tool, content: "", timestamp: 2)
        second.backgroundTaskId = "bg-2"
        second.toolStatus = .asyncPending
        vm.mutateEngineInstance(tabId: "tab-1", instanceId: nil) {
            $0.messages = [first, second]
            $0.activeBackgroundTasks = [
                BackgroundTaskState(taskId: "bg-1", command: "one", startedAt: 1, notifyOnComplete: false),
                BackgroundTaskState(taskId: "bg-2", command: "two", startedAt: 2, notifyOnComplete: true),
            ]
        }

        vm.handleBackgroundTaskTerminal(tabId: "tab-1", instanceId: nil, taskId: "bg-1", status: "stopped")

        let instance = vm.engineInstance(tabId: "tab-1", instanceId: nil)
        XCTAssertEqual(instance?.activeBackgroundTasks?.map(\.taskId), ["bg-2"])
        XCTAssertEqual(instance?.messages.map(\.toolStatus), [.asyncPending, .asyncPending])
    }

    @MainActor
    func testStopRefusalShowsErrorToast() {
        let vm = SessionViewModel()
        vm.stoppingBackgroundTaskIds.insert("bg-1")
        vm.handleBackgroundTaskStopResult(requestId: "r1", taskId: "bg-1", status: "ownership_mismatch", error: "Task belongs to another session.")
        XCTAssertFalse(vm.stoppingBackgroundTaskIds.contains("bg-1"))
        XCTAssertTrue(vm.toastMessages.contains { $0.style == .error && $0.title == "Stop failed" })
    }

    /// The shared `BackgroundWorkItem` makes `source` and `exitCode`
    /// optional. Requiring them failed the whole row that carried the item.
    func testAnItemWithoutSourceOrExitCodeDecodes() throws {
        let json = #"{"id":"e1","role":"system","content":"Delivered.","timestamp":1,"backgroundWork":{"kind":"agent","deliveryMode":"wake","items":[{"id":"bg-1","status":"completed"}]}}"#
        let row = try JSONDecoder().decode(TranscriptRow.self, from: Data(json.utf8)).message
        XCTAssertEqual(row.backgroundWork?.items.first?.id, "bg-1")
        XCTAssertNil(row.backgroundWork?.items.first?.exitCode)
        XCTAssertNil(row.backgroundWork?.items.first?.source)
    }

    // MARK: - Human steer unchanged

    func testHumanSteerNotAffectedByBackgroundWorkRemoval() {
        let user = Message(id: "u1", role: .user, content: "hello", timestamp: 1)
        var tool = Message(id: "t1", role: .tool, content: "res", timestamp: 2)
        tool.toolName = "Bash"
        tool.toolStatus = .completed
        let assistant = Message(id: "a1", role: .assistant, content: "reply", timestamp: 3)
        let grouped = groupConversationItems([user, tool, assistant], unifiedTurnView: false)
        XCTAssertEqual(grouped.count, 3)
        guard case .user = grouped[0] else { return XCTFail("expected user") }
        guard case .toolGroup = grouped[1] else { return XCTFail("expected toolGroup") }
        guard case .assistant = grouped[2] else { return XCTFail("expected assistant") }
    }
}
