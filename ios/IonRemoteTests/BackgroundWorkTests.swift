import XCTest
@testable import IonRemote

/// Tests wire decode, round-trip, grouping, and compaction separation for
/// delivered background work metadata.
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

    func testBackgroundWorkDeliveredDecodesNoStandaloneRow() throws {
        let json = """
        {"type":"desktop_background_work_delivered","tabId":"tab","message":{"id":"entry-1","role":"system","content":"Background command bash-1 (completed).","timestamp":1,"backgroundWork":{"kind":"background_task_completion","deliveryMode":"wake","items":[{"id":"bash-1","source":"bash","label":"npm test","status":"completed","exitCode":0,"elapsedMs":800}]}}}
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .backgroundWorkDelivered(let tabId, let instanceId, let message) = event else {
            return XCTFail("expected background work event")
        }
        XCTAssertEqual(tabId, "tab")
        XCTAssertNil(instanceId)
        XCTAssertEqual(message.backgroundWork?.items.first?.id, "bash-1")
    }

    func testBackgroundWorkEventRoundTrips() throws {
        var message = Message(id: "entry-1", role: .system, content: "payload", timestamp: 1)
        message.backgroundWork = work
        let data = try JSONEncoder().encode(RemoteEvent.backgroundWorkDelivered(tabId: "tab", instanceId: "main", message: message))
        let decoded = try JSONDecoder().decode(RemoteEvent.self, from: data)
        guard case .backgroundWorkDelivered(_, _, let restored) = decoded else {
            return XCTFail("expected decoded delivery")
        }
        XCTAssertEqual(restored.backgroundWork, work)
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

    // MARK: - Encoder round-trip

    func testToolEndEncoderTransmitsBackgroundTaskId() throws {
        let event = RemoteEvent.engineToolEnd(
            tabId: "tab1", instanceId: nil, toolId: "t1",
            result: "ok", isError: false, backgroundTaskId: "bg-99"
        )
        let data = try JSONEncoder().encode(event)
        let decoded = try JSONDecoder().decode(RemoteEvent.self, from: data)
        guard case .engineToolEnd(_, _, _, _, _, let bgId) = decoded else {
            return XCTFail("expected engineToolEnd")
        }
        XCTAssertEqual(bgId, "bg-99")
    }

    func testToolEndEncoderOmitsNilBackgroundTaskId() throws {
        let event = RemoteEvent.engineToolEnd(
            tabId: "tab1", instanceId: nil, toolId: "t1",
            result: "ok", isError: false
        )
        let data = try JSONEncoder().encode(event)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNil(json?["backgroundTaskId"])
    }

    // MARK: - Status mapping

    func testFailedItemStatusDecodes() throws {
        let json = """
        {"type":"desktop_background_work_delivered","tabId":"tab","message":{"id":"e1","role":"system","content":"Failed.","timestamp":1,"backgroundWork":{"kind":"background_task_completion","deliveryMode":"wake","items":[{"id":"bg-1","source":"bash","label":"npm test","status":"failed","exitCode":1,"elapsedMs":500}]}}}
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .backgroundWorkDelivered(_, _, let message) = event else {
            return XCTFail("expected backgroundWorkDelivered")
        }
        XCTAssertEqual(message.backgroundWork?.items.first?.status, "failed")
    }

    func testFailedItemSetsErrorStatus() {
        var tool = Message(id: "t1", role: .tool, content: "old", timestamp: 1)
        tool.toolName = "Bash"
        tool.toolId = "t1"
        tool.toolStatus = .asyncPending
        tool.backgroundTaskId = "bg-1"

        let failedWork = BackgroundWorkMetadata(
            kind: "background_task_completion",
            deliveryMode: "wake",
            items: [BackgroundWorkItem(id: "bg-1", source: "bash", label: "npm test", status: "failed", exitCode: 1, elapsedMs: 500, outputPath: nil)],
            remainingTaskIds: []
        )
        var msgs = [tool]
        applyBackgroundWorkFold(messages: &msgs, deliveredWork: failedWork, deliveredContent: "Failed.")
        XCTAssertEqual(msgs[0].toolStatus, .error)
    }

    func testStoppedItemSetsErrorStatus() {
        var tool = Message(id: "t1", role: .tool, content: "old", timestamp: 1)
        tool.toolName = "Bash"
        tool.toolId = "t1"
        tool.toolStatus = .asyncPending
        tool.backgroundTaskId = "bg-1"

        let stoppedWork = BackgroundWorkMetadata(
            kind: "background_task_completion",
            deliveryMode: "wake",
            items: [BackgroundWorkItem(id: "bg-1", source: "bash", label: "npm test", status: "stopped", exitCode: -1, elapsedMs: 200, outputPath: nil)],
            remainingTaskIds: []
        )
        var msgs = [tool]
        applyBackgroundWorkFold(messages: &msgs, deliveredWork: stoppedWork, deliveredContent: "Stopped.")
        XCTAssertEqual(msgs[0].toolStatus, .error)
    }

    func testCompletedItemSetsCompletedStatus() {
        var tool = Message(id: "t1", role: .tool, content: "old", timestamp: 1)
        tool.toolName = "Bash"
        tool.toolId = "t1"
        tool.toolStatus = .asyncPending
        tool.backgroundTaskId = "bash-1"

        var msgs = [tool]
        applyBackgroundWorkFold(messages: &msgs, deliveredWork: work, deliveredContent: "Done.")
        XCTAssertEqual(msgs[0].toolStatus, .completed)
    }

    // MARK: - Item ID folding

    func testFoldingUsesItemIdsToMatch() {
        var tool1 = Message(id: "t1", role: .tool, content: "old1", timestamp: 1)
        tool1.toolName = "Bash"
        tool1.toolId = "t1"
        tool1.toolStatus = .asyncPending
        tool1.backgroundTaskId = "bg-1"

        var tool2 = Message(id: "t2", role: .tool, content: "old2", timestamp: 2)
        tool2.toolName = "Bash"
        tool2.toolId = "t2"
        tool2.toolStatus = .asyncPending
        tool2.backgroundTaskId = "bg-2"

        let deliveredWork = BackgroundWorkMetadata(
            kind: "background_task_completion",
            deliveryMode: "wake",
            items: [BackgroundWorkItem(id: "bg-1", source: "bash", label: "npm test", status: "completed", exitCode: 0, elapsedMs: 800, outputPath: nil)],
            remainingTaskIds: []
        )
        var msgs = [tool1, tool2]
        let count = applyBackgroundWorkFold(messages: &msgs, deliveredWork: deliveredWork, deliveredContent: "Done.")
        XCTAssertEqual(count, 1)
        XCTAssertEqual(msgs[0].toolStatus, .completed)
        XCTAssertEqual(msgs[1].toolStatus, .asyncPending)
    }

    // MARK: - Payload replacement

    func testDeliveredPayloadReplacesToolContent() {
        var tool = Message(id: "t1", role: .tool, content: "old result", timestamp: 1)
        tool.toolName = "Bash"
        tool.toolId = "t1"
        tool.toolStatus = .asyncPending
        tool.backgroundTaskId = "bash-1"

        let deliveredContent = "Background command bash-1 (completed)."
        var msgs = [tool]
        applyBackgroundWorkFold(messages: &msgs, deliveredWork: work, deliveredContent: deliveredContent)
        XCTAssertEqual(msgs[0].content, deliveredContent)
        XCTAssertNotNil(msgs[0].backgroundWork)
        XCTAssertEqual(msgs[0].backgroundWork, work)
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

    func testStopBackgroundTaskCommandRoundTrips() throws {
        let command = RemoteCommand.stopBackgroundTask(tabId: "tab-1", taskId: "bg-9", requestId: "request-4")
        let data = try JSONEncoder().encode(command)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_stop_background_task")
        XCTAssertEqual(json["taskId"] as? String, "bg-9")
        XCTAssertEqual(json["requestId"] as? String, "request-4")
        guard case .stopBackgroundTask(let tabId, let taskId, let requestId) = try JSONDecoder().decode(RemoteCommand.self, from: data) else {
            return XCTFail("expected stopBackgroundTask")
        }
        XCTAssertEqual([tabId, taskId, requestId], ["tab-1", "bg-9", "request-4"])
    }

    func testBackgroundTaskLifecycleMatchesDesktopWireShape() throws {
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()

        let started = try decoder.decode(RemoteEvent.self, from: #"{"type":"desktop_background_task_started","tabId":"tab-1","instanceId":"main","task":{"taskId":"bg-1","toolId":"tool-1","command":"sleep 10","startedAt":123,"notifyOnComplete":false}}"#.data(using: .utf8)!)
        guard case .engineBackgroundTaskStarted(_, _, let taskId, let command, let startedAt, let notify) = started else {
            return XCTFail("expected started event")
        }
        XCTAssertEqual(taskId, "bg-1")
        XCTAssertEqual(command, "sleep 10")
        XCTAssertEqual(startedAt, 123)
        XCTAssertFalse(notify)
        let startedJSON = try JSONSerialization.jsonObject(with: encoder.encode(started)) as! [String: Any]
        XCTAssertNotNil(startedJSON["task"])
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

    @MainActor
    func testTerminalEventRemovesExactTaskAndSettlesTool() {
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
        XCTAssertEqual(instance?.messages[0].toolStatus, .error)
        XCTAssertEqual(instance?.messages[1].toolStatus, .asyncPending)
    }

    @MainActor
    func testStopRefusalShowsErrorToast() {
        let vm = SessionViewModel()
        vm.stoppingBackgroundTaskIds.insert("bg-1")
        vm.handleBackgroundTaskStopResult(requestId: "r1", taskId: "bg-1", status: "ownership_mismatch", error: "Task belongs to another session.")
        XCTAssertFalse(vm.stoppingBackgroundTaskIds.contains("bg-1"))
        XCTAssertTrue(vm.toastMessages.contains { $0.style == .error && $0.title == "Stop failed" })
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

// MARK: - Test helper

@discardableResult
private func applyBackgroundWorkFold(messages: inout [Message], deliveredWork: BackgroundWorkMetadata, deliveredContent: String) -> Int {
    let itemIds = Set(deliveredWork.items.map(\.id))
    var matchCount = 0
    for i in messages.indices {
        guard let toolBgId = messages[i].backgroundTaskId,
              messages[i].toolStatus == .asyncPending,
              itemIds.contains(toolBgId) else { continue }
        let item = deliveredWork.items.first { $0.id == toolBgId }
        let status = item?.status ?? "completed"
        messages[i].toolStatus = (status == "completed") ? .completed : .error
        messages[i].content = deliveredContent
        messages[i].backgroundWork = deliveredWork
        matchCount += 1
    }
    return matchCount
}
