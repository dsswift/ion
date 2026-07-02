import XCTest
@testable import IonRemote

/// Tests for the dispatch-telemetry data path:
/// - DispatchTelemetryEntry model decode
/// - Telemetry accumulation (start appends, end matches by exact dispatchId)
/// - Child accessor returns correct entries by parentDispatchId
/// - Snapshot projection decodes dispatchTelemetry on ConversationInstanceInfo
/// - Grouping migration parity (groupConversationItems produces .compaction/.agentTurn)
/// - Pinned prompt present/absent
/// - Breadcrumb model
@MainActor
final class DispatchTelemetryTests: XCTestCase {

    // MARK: - Telemetry accumulation: start then end

    /// Start appends an entry keyed by dispatchId; end matches by exact
    /// dispatchId and updates exitCode/elapsed/conversationId.
    func testAccumulateStartThenEnd() {
        let vm = SessionViewModel()

        // Seed a tab with a conversation instance.
        let tab = RemoteTabState(
            id: "tab-1", title: "Test", status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto,
            permissionQueue: [],
            conversationInstances: [
                ConversationInstanceInfo(id: "main", label: "default")
            ],
            activeConversationInstanceId: "main"
        )
        vm.tabs = [tab]
        vm.tabIds = Set(["tab-1"])
        vm.conversationInstances["tab-1"] = [ConversationInstanceInfo(id: "main", label: "default")]
        vm.activeEngineInstance["tab-1"] = "main"

        // Fire dispatch_start.
        let startEvent = RemoteEvent.engineDispatchStart(
            tabId: "tab-1", instanceId: "main",
            dispatchAgent: "engine-dev",
            dispatchSessionId: "sess-1",
            dispatchModel: "opus",
            dispatchTask: "implement feature",
            dispatchDepth: 1,
            dispatchParentId: "root-id",
            dispatchId: "dispatch-abc"
        )
        vm.handleEvent(startEvent)

        // Verify entry appended.
        let inst = vm.engineInstance(tabId: "tab-1", instanceId: "main")
        let telemetry = inst?.dispatchTelemetry ?? []
        XCTAssertEqual(telemetry.count, 1, "dispatch_start should append one entry")
        XCTAssertEqual(telemetry[0].dispatchId, "dispatch-abc")
        XCTAssertEqual(telemetry[0].dispatchAgent, "engine-dev")
        XCTAssertEqual(telemetry[0].dispatchSessionId, "sess-1")
        XCTAssertEqual(telemetry[0].dispatchModel, "opus")
        XCTAssertEqual(telemetry[0].dispatchTask, "implement feature")
        XCTAssertEqual(telemetry[0].dispatchDepth, 1)
        XCTAssertEqual(telemetry[0].dispatchParentId, "root-id")
        XCTAssertNil(telemetry[0].exitCode, "exitCode should be nil before dispatch_end")
        XCTAssertNil(telemetry[0].conversationId, "conversationId should be nil before dispatch_end")

        // Fire dispatch_end with matching dispatchId.
        let endEvent = RemoteEvent.engineDispatchEnd(
            tabId: "tab-1", instanceId: "main",
            dispatchAgent: "engine-dev",
            dispatchDepth: 1,
            dispatchParentId: "root-id",
            exitCode: 0,
            elapsed: 12.5,
            dispatchId: "dispatch-abc",
            conversationId: "conv-child-1"
        )
        vm.handleEvent(endEvent)

        // Verify entry updated.
        let updated = vm.engineInstance(tabId: "tab-1", instanceId: "main")
        let updatedTelemetry = updated?.dispatchTelemetry ?? []
        XCTAssertEqual(updatedTelemetry.count, 1, "dispatch_end should not add a new entry")
        XCTAssertEqual(updatedTelemetry[0].exitCode, 0)
        XCTAssertEqual(updatedTelemetry[0].elapsed, 12.5)
        XCTAssertEqual(updatedTelemetry[0].conversationId, "conv-child-1")
    }

    /// Two concurrent dispatches: end matches by EXACT dispatchId, not by
    /// depth or agent name.
    func testExactDispatchIdMatch() {
        let vm = SessionViewModel()
        vm.tabs = [RemoteTabState(id: "t1", title: "T", status: .running, workingDirectory: "/", permissionMode: .auto, permissionQueue: [], conversationInstances: [ConversationInstanceInfo(id: "main", label: "d")], activeConversationInstanceId: "main")]
        vm.tabIds = Set(["t1"])
        vm.conversationInstances["t1"] = [ConversationInstanceInfo(id: "main", label: "d")]
        vm.activeEngineInstance["t1"] = "main"

        // Two starts at same depth.
        vm.handleEvent(.engineDispatchStart(tabId: "t1", instanceId: "main", dispatchAgent: "agent-a", dispatchSessionId: "s1", dispatchModel: "m1", dispatchTask: "t1", dispatchDepth: 1, dispatchParentId: "root", dispatchId: "id-alpha"))
        vm.handleEvent(.engineDispatchStart(tabId: "t1", instanceId: "main", dispatchAgent: "agent-b", dispatchSessionId: "s2", dispatchModel: "m2", dispatchTask: "t2", dispatchDepth: 1, dispatchParentId: "root", dispatchId: "id-beta"))

        // End for id-beta only.
        vm.handleEvent(.engineDispatchEnd(tabId: "t1", instanceId: "main", dispatchAgent: "agent-b", dispatchDepth: 1, dispatchParentId: "root", exitCode: 1, elapsed: 5.0, dispatchId: "id-beta", conversationId: "conv-beta"))

        let entries = vm.engineInstance(tabId: "t1", instanceId: "main")?.dispatchTelemetry ?? []
        XCTAssertEqual(entries.count, 2)
        // id-alpha should be untouched.
        let alpha = entries.first(where: { $0.dispatchId == "id-alpha" })
        XCTAssertNil(alpha?.exitCode, "alpha should not have been updated by beta's end")
        // id-beta should have end data.
        let beta = entries.first(where: { $0.dispatchId == "id-beta" })
        XCTAssertEqual(beta?.exitCode, 1)
        XCTAssertEqual(beta?.elapsed, 5.0)
        XCTAssertEqual(beta?.conversationId, "conv-beta")
    }

    // MARK: - Child accessor

    func testChildAccessorReturnsByParentDispatchId() {
        let vm = SessionViewModel()
        vm.tabs = [RemoteTabState(id: "t1", title: "T", status: .idle, workingDirectory: "/", permissionMode: .auto, permissionQueue: [], conversationInstances: [ConversationInstanceInfo(id: "main", label: "d")], activeConversationInstanceId: "main")]
        vm.tabIds = Set(["t1"])
        vm.conversationInstances["t1"] = [ConversationInstanceInfo(id: "main", label: "d")]
        vm.activeEngineInstance["t1"] = "main"

        // Root dispatch.
        vm.handleEvent(.engineDispatchStart(tabId: "t1", instanceId: "main", dispatchAgent: "orchestrator", dispatchSessionId: "s0", dispatchModel: "opus", dispatchTask: "root", dispatchDepth: 0, dispatchParentId: "", dispatchId: "root-id"))
        // Two children of root.
        vm.handleEvent(.engineDispatchStart(tabId: "t1", instanceId: "main", dispatchAgent: "engine-dev", dispatchSessionId: "s1", dispatchModel: "sonnet", dispatchTask: "impl", dispatchDepth: 1, dispatchParentId: "root-id", dispatchId: "child-1"))
        vm.handleEvent(.engineDispatchStart(tabId: "t1", instanceId: "main", dispatchAgent: "ios-dev", dispatchSessionId: "s2", dispatchModel: "haiku", dispatchTask: "review", dispatchDepth: 1, dispatchParentId: "root-id", dispatchId: "child-2"))
        // Grandchild of child-1.
        vm.handleEvent(.engineDispatchStart(tabId: "t1", instanceId: "main", dispatchAgent: "test-runner", dispatchSessionId: "s3", dispatchModel: "haiku", dispatchTask: "test", dispatchDepth: 2, dispatchParentId: "child-1", dispatchId: "grandchild-1"))

        let rootChildren = vm.childDispatchTelemetry(tabId: "t1", parentDispatchId: "root-id")
        XCTAssertEqual(rootChildren.count, 2, "root should have 2 children")
        XCTAssertEqual(Set(rootChildren.map(\.dispatchId)), Set(["child-1", "child-2"]))

        let child1Children = vm.childDispatchTelemetry(tabId: "t1", parentDispatchId: "child-1")
        XCTAssertEqual(child1Children.count, 1, "child-1 should have 1 grandchild")
        XCTAssertEqual(child1Children[0].dispatchId, "grandchild-1")
        XCTAssertEqual(child1Children[0].dispatchDepth, 2)

        let child2Children = vm.childDispatchTelemetry(tabId: "t1", parentDispatchId: "child-2")
        XCTAssertEqual(child2Children.count, 0, "child-2 has no children")
    }

    // MARK: - Durable agent-state child accessor

    /// Build an AgentStateUpdate through the real Codable decoder, carrying the
    /// dispatch attribution metadata the engine stamps (dispatchParentId).
    private func makeAgentPill(name: String, parent: String) -> AgentStateUpdate {
        let raw: [String: Any] = [
            "id": "dispatch-\(name)-1",
            "name": name,
            "status": "done",
            "metadata": [
                "displayName": name,
                "type": "specialist",
                "visibility": "ephemeral",
                "invited": false,
                "dispatchDepth": 2,
                "dispatchParentId": parent,
            ] as [String: Any],
        ]
        let data = try! JSONSerialization.data(withJSONObject: raw)
        return try! JSONDecoder().decode(AgentStateUpdate.self, from: data)
    }

    /// The durable preview source: childAgentStates filters the agent-state
    /// list (which survives engine_agent_state heartbeat replay) by
    /// dispatchParentId, so a nested child renders even after the one-shot
    /// dispatchTelemetry stream is gone. This is the iOS parity pin for the
    /// empty-preview regression.
    func testChildAgentStatesReturnsByParentDispatchId() {
        let vm = SessionViewModel()
        vm.tabs = [RemoteTabState(id: "t1", title: "T", status: .idle, workingDirectory: "/", permissionMode: .auto, permissionQueue: [], conversationInstances: [ConversationInstanceInfo(id: "main", label: "d")], activeConversationInstanceId: "main")]
        vm.tabIds = Set(["t1"])
        vm.conversationInstances["t1"] = [ConversationInstanceInfo(id: "main", label: "d")]
        vm.activeEngineInstance["t1"] = "main"

        // Populate agent-state pills (NOT telemetry) — the durable source.
        let pills = [
            makeAgentPill(name: "engine-dev", parent: "dev-lead-dispatch-1"),
            makeAgentPill(name: "desktop-dev", parent: "dev-lead-dispatch-1"),
            makeAgentPill(name: "qa-reviewer", parent: "other-dispatch"),
        ]
        vm.handleEvent(.engineAgentState(tabId: "t1", instanceId: "main", agents: pills))

        let children = vm.childAgentStates(tabId: "t1", parentDispatchId: "dev-lead-dispatch-1")
        XCTAssertEqual(Set(children.map(\.name)), Set(["engine-dev", "desktop-dev"]))

        // No match -> empty.
        XCTAssertTrue(vm.childAgentStates(tabId: "t1", parentDispatchId: "nope").isEmpty)
        // Empty parent id -> empty (root pills are not children).
        XCTAssertTrue(vm.childAgentStates(tabId: "t1", parentDispatchId: "").isEmpty)
    }

    // MARK: - Snapshot decode

    func testSnapshotDecodesDispatchTelemetry() throws {
        let json = """
        {
            "id": "tab-1", "title": "Test", "status": "idle",
            "workingDirectory": "/tmp", "permissionMode": "auto",
            "permissionQueue": [],
            "conversationInstances": [{
                "id": "main", "label": "default",
                "dispatchTelemetry": [{
                    "dispatchAgent": "engine-dev",
                    "dispatchSessionId": "sess-1",
                    "dispatchModel": "opus",
                    "dispatchTask": "build feature",
                    "dispatchDepth": 1,
                    "dispatchParentId": "root",
                    "dispatchId": "d-1",
                    "conversationId": "conv-1",
                    "exitCode": 0,
                    "elapsed": 30.5,
                    "cost": 0.12
                }]
            }]
        }
        """.data(using: .utf8)!
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: json)
        let instances = tab.conversationInstances ?? []
        XCTAssertEqual(instances.count, 1)
        let telemetry = instances[0].dispatchTelemetry ?? []
        XCTAssertEqual(telemetry.count, 1)
        XCTAssertEqual(telemetry[0].dispatchAgent, "engine-dev")
        XCTAssertEqual(telemetry[0].dispatchSessionId, "sess-1")
        XCTAssertEqual(telemetry[0].dispatchModel, "opus")
        XCTAssertEqual(telemetry[0].dispatchTask, "build feature")
        XCTAssertEqual(telemetry[0].dispatchDepth, 1)
        XCTAssertEqual(telemetry[0].dispatchParentId, "root")
        XCTAssertEqual(telemetry[0].dispatchId, "d-1")
        XCTAssertEqual(telemetry[0].conversationId, "conv-1")
        XCTAssertEqual(telemetry[0].exitCode, 0)
        XCTAssertEqual(telemetry[0].elapsed, 30.5)
        XCTAssertEqual(telemetry[0].cost, 0.12)
    }

    func testSnapshotDecodesWithoutDispatchTelemetry() throws {
        let json = """
        {
            "id": "tab-1", "title": "Test", "status": "idle",
            "workingDirectory": "/tmp", "permissionMode": "auto",
            "permissionQueue": [],
            "conversationInstances": [{
                "id": "main", "label": "default"
            }]
        }
        """.data(using: .utf8)!
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: json)
        let instances = tab.conversationInstances ?? []
        XCTAssertEqual(instances.count, 1)
        XCTAssertNil(instances[0].dispatchTelemetry, "absent field should decode as nil (back-compat)")
    }

    // MARK: - Grouping migration parity

    /// Dispatch messages through groupConversationItems should produce
    /// .compaction and .agentTurn, matching what the old groupDispatchItems
    /// produced for tool/single plus the new variants.
    func testGroupingProducesCompactionAndAgentTurn() {
        let msgs: [Message] = [
            Message(id: "u1", role: .user, content: "Hello", timestamp: 1),
            Message(id: "t1", role: .tool, content: "result", toolName: "Read", timestamp: 2),
            Message(id: "t2", role: .tool, content: "result2", toolName: "Write", timestamp: 3),
            Message(id: "a1", role: .assistant, content: "Done", timestamp: 4),
            Message(id: "c1", role: .system, content: "[Compaction] summary", timestamp: 5),
            Message(id: "u2", role: .user, content: "Continue", timestamp: 6),
        ]

        let items = groupConversationItems(msgs, unifiedTurnView: true)

        // user, agentTurn(tools+assistant), compaction, user
        XCTAssertEqual(items.count, 4, "Expected 4 grouped items")

        if case .user(let m) = items[0] {
            XCTAssertEqual(m.id, "u1")
        } else {
            XCTFail("Expected .user at index 0, got \(items[0])")
        }

        if case .agentTurn(let tools, let assistants, _, _) = items[1] {
            XCTAssertEqual(tools.count, 2, "Should have 2 tools")
            XCTAssertEqual(assistants.count, 1, "Should have 1 assistant")
        } else {
            XCTFail("Expected .agentTurn at index 1, got \(items[1])")
        }

        if case .compaction(let m) = items[2] {
            XCTAssertEqual(m.id, "c1")
        } else {
            XCTFail("Expected .compaction at index 2, got \(items[2])")
        }

        if case .user(let m) = items[3] {
            XCTAssertEqual(m.id, "u2")
        } else {
            XCTFail("Expected .user at index 3, got \(items[3])")
        }
    }

    /// Tool/single parity: classic grouping produces toolGroup for consecutive
    /// tools and single for everything else.
    func testGroupingClassicToolSingleParity() {
        let msgs: [Message] = [
            Message(id: "a1", role: .assistant, content: "Checking", timestamp: 1),
            Message(id: "t1", role: .tool, content: "ok", toolName: "Read", timestamp: 2),
            Message(id: "t2", role: .tool, content: "ok", toolName: "Grep", timestamp: 3),
            Message(id: "a2", role: .assistant, content: "Done", timestamp: 4),
        ]

        let items = groupConversationItems(msgs, unifiedTurnView: false)
        XCTAssertEqual(items.count, 3, "assistant, toolGroup, assistant")

        if case .assistant = items[0] {} else {
            XCTFail("Expected .assistant at 0")
        }
        if case .toolGroup(let tools) = items[1] {
            XCTAssertEqual(tools.count, 2)
        } else {
            XCTFail("Expected .toolGroup at 1")
        }
        if case .assistant = items[2] {} else {
            XCTFail("Expected .assistant at 2")
        }
    }

    // MARK: - Kind coverage

    /// CompactionRowView renders for [Compaction] messages.
    func testCompactionKindCoverage() {
        let msgs: [Message] = [
            Message(id: "c1", role: .system, content: "[Compaction] Previous context summarized.", timestamp: 1),
        ]
        let items = groupConversationItems(msgs, unifiedTurnView: true)
        XCTAssertEqual(items.count, 1)
        if case .compaction(let m) = items[0] {
            XCTAssertTrue(m.content.hasPrefix("[Compaction]"))
        } else {
            XCTFail("Expected .compaction")
        }
    }

    /// System divider lines (like "──") produce .system items.
    func testEngineSystemBubbleDivider() {
        let msgs: [Message] = [
            Message(id: "s1", role: .system, content: "──────────────────", timestamp: 1),
        ]
        let items = groupConversationItems(msgs, unifiedTurnView: true)
        XCTAssertEqual(items.count, 1)
        if case .system(let m) = items[0] {
            XCTAssertTrue(m.content.contains("──"))
        } else {
            XCTFail("Expected .system")
        }
    }

    // MARK: - Same-name dispatch isolation (live second-tier child-panel bug)

    /// Build a dev-lead pill that carries TWO dispatches in its dispatches[] —
    /// exactly what the engine's groupByName produces when the same agent name
    /// is dispatched twice. The merged pill is the representative that the engine
    /// emits as a SINGLE AgentStateUpdate with both dispatch entries inside
    /// metadata["dispatches"]. Each dispatch has its own unique dispatchId.
    private func makeMergedDevLeadPill(
        dispatchId1: String, dispatchId2: String, convId1: String, convId2: String
    ) -> AgentStateUpdate {
        let raw: [String: Any] = [
            "id": "dev-lead-pill",
            "name": "dev-lead",
            "status": "done",
            "metadata": [
                "displayName": "Dev Lead",
                "type": "specialist",
                "visibility": "ephemeral",
                "invited": false,
                "dispatchDepth": 1,
                "dispatchParentId": "",
                // Merged dispatches[] — mirrors engine groupByName output.
                "dispatches": [
                    [
                        "id": dispatchId1,
                        "task": "task-1",
                        "model": "opus",
                        "conversationId": convId1,
                        "status": "done",
                    ] as [String: Any],
                    [
                        "id": dispatchId2,
                        "task": "task-2",
                        "model": "opus",
                        "conversationId": convId2,
                        "status": "done",
                    ] as [String: Any],
                ],
            ] as [String: Any],
        ]
        let data = try! JSONSerialization.data(withJSONObject: raw)
        return try! JSONDecoder().decode(AgentStateUpdate.self, from: data)
    }

    /// Build a child pill (e.g. engine-dev) that is attributed to a specific
    /// parent dispatch via dispatchParentId.
    private func makeChildPill(
        name: String, agentId: String, parentDispatchId: String
    ) -> AgentStateUpdate {
        let raw: [String: Any] = [
            "id": agentId,
            "name": name,
            "status": "done",
            "metadata": [
                "displayName": name,
                "type": "specialist",
                "visibility": "ephemeral",
                "invited": false,
                "dispatchDepth": 2,
                "dispatchParentId": parentDispatchId,
            ] as [String: Any],
        ]
        let data = try! JSONSerialization.data(withJSONObject: raw)
        return try! JSONDecoder().decode(AgentStateUpdate.self, from: data)
    }

    /// Pin: two same-name dev-lead dispatches collapse into ONE merged pill.
    /// childAgentStates filtered by dispatch-1's id returns ONLY dispatch-1's
    /// engine-dev; filtered by dispatch-2's id returns ONLY dispatch-2's
    /// engine-dev. The two sets are non-overlapping.
    ///
    /// This is the live second-tier bug fix pin: before the fix, both calls
    /// would have used dispatches.last?.id and returned dispatch-2's children
    /// regardless of which dispatch was opened.
    func testSameNameDispatchesHaveDistinctChildrenPerDispatchId() {
        let vm = SessionViewModel()
        vm.tabs = [RemoteTabState(id: "t1", title: "T", status: .idle, workingDirectory: "/", permissionMode: .auto, permissionQueue: [], conversationInstances: [ConversationInstanceInfo(id: "main", label: "d")], activeConversationInstanceId: "main")]
        vm.tabIds = Set(["t1"])
        vm.conversationInstances["t1"] = [ConversationInstanceInfo(id: "main", label: "d")]
        vm.activeEngineInstance["t1"] = "main"

        // The engine emits ONE merged dev-lead pill with two dispatch entries.
        let devLeadPill = makeMergedDevLeadPill(
            dispatchId1: "dev-lead-dispatch-1",
            dispatchId2: "dev-lead-dispatch-2",
            convId1: "conv-dl-1",
            convId2: "conv-dl-2"
        )

        // Each dispatch has its OWN engine-dev child, attributed via dispatchParentId.
        let engineDev1 = makeChildPill(name: "engine-dev", agentId: "engine-dev-for-dl1", parentDispatchId: "dev-lead-dispatch-1")
        let engineDev2 = makeChildPill(name: "engine-dev", agentId: "engine-dev-for-dl2", parentDispatchId: "dev-lead-dispatch-2")

        vm.handleEvent(.engineAgentState(tabId: "t1", instanceId: "main",
            agents: [devLeadPill, engineDev1, engineDev2]))

        // Selecting dev-lead dispatch-1 MUST show only dispatch-1's engine-dev.
        let children1 = vm.childAgentStates(tabId: "t1", parentDispatchId: "dev-lead-dispatch-1")
        XCTAssertEqual(children1.count, 1, "dispatch-1 should have exactly 1 child")
        XCTAssertEqual(children1[0].agentId, "engine-dev-for-dl1",
            "dispatch-1's child must be engine-dev-for-dl1, not dispatch-2's child")

        // Selecting dev-lead dispatch-2 MUST show only dispatch-2's engine-dev.
        let children2 = vm.childAgentStates(tabId: "t1", parentDispatchId: "dev-lead-dispatch-2")
        XCTAssertEqual(children2.count, 1, "dispatch-2 should have exactly 1 child")
        XCTAssertEqual(children2[0].agentId, "engine-dev-for-dl2",
            "dispatch-2's child must be engine-dev-for-dl2, not dispatch-1's child")

        // The two child sets are disjoint.
        XCTAssertNotEqual(children1[0].agentId, children2[0].agentId,
            "each dispatch must resolve its own distinct engine-dev child")
    }

    /// Pin: AgentDetailFullScreenView.childAgents uses the view's own dispatchId
    /// (the one it was opened with), NOT dispatches.last?.id. This test simulates
    /// the exact failure mode: a merged pill where dispatches.last is dispatch-2
    /// but the view was opened for dispatch-1. childAgentStates keyed on
    /// dispatch-1's id must return dispatch-1's children, not dispatch-2's.
    ///
    /// The view-level fix: childAgents now reads `self.dispatchId` first (the
    /// prop passed at init) and falls back to dispatches.last only when
    /// dispatchId is empty. This test pins that the accessor layer (which the
    /// view delegates to) provides the correct answer when called with the right
    /// dispatch id.
    func testChildAgentsAccessorKeyedOnOpenedDispatchNotLast() {
        let vm = SessionViewModel()
        vm.tabs = [RemoteTabState(id: "t1", title: "T", status: .idle, workingDirectory: "/", permissionMode: .auto, permissionQueue: [], conversationInstances: [ConversationInstanceInfo(id: "main", label: "d")], activeConversationInstanceId: "main")]
        vm.tabIds = Set(["t1"])
        vm.conversationInstances["t1"] = [ConversationInstanceInfo(id: "main", label: "d")]
        vm.activeEngineInstance["t1"] = "main"

        // Merged pill: dispatches.last is "dl-2" (the pathological case that
        // caused the bug — using .last would always return dl-2's children).
        let devLeadPill = makeMergedDevLeadPill(
            dispatchId1: "dl-1", dispatchId2: "dl-2",
            convId1: "conv-1", convId2: "conv-2"
        )
        let childForDl1 = makeChildPill(name: "engine-dev", agentId: "child-for-dl1", parentDispatchId: "dl-1")
        let childForDl2 = makeChildPill(name: "engine-dev", agentId: "child-for-dl2", parentDispatchId: "dl-2")

        vm.handleEvent(.engineAgentState(tabId: "t1", instanceId: "main",
            agents: [devLeadPill, childForDl1, childForDl2]))

        // Verify the merged pill's dispatches — last dispatch id is "dl-2".
        let states = vm.engineInstance(tabId: "t1", instanceId: "main")?.agentStates ?? []
        let pill = states.first(where: { $0.dispatches.contains(where: { $0.id == "dl-1" }) })
        XCTAssertNotNil(pill, "merged pill must be findable by dispatch-1 id")
        XCTAssertEqual(pill?.dispatches.last?.id, "dl-2",
            "dispatches.last is dl-2 — using it would return the wrong children")

        // The fix: caller provides "dl-1" (the opened dispatch id), NOT .last.
        // childAgentStates keyed on "dl-1" must return dl-1's child, not dl-2's.
        let childrenViaOpenedId = vm.childAgentStates(tabId: "t1", parentDispatchId: "dl-1")
        XCTAssertEqual(childrenViaOpenedId.count, 1)
        XCTAssertEqual(childrenViaOpenedId[0].agentId, "child-for-dl1",
            "opening dispatch-1 must show child-for-dl1, not child-for-dl2 (dispatches.last bug)")

        // Confirm that using .last (the pre-fix path) would return the WRONG child.
        let childrenViaLast = vm.childAgentStates(tabId: "t1", parentDispatchId: "dl-2")
        XCTAssertEqual(childrenViaLast[0].agentId, "child-for-dl2",
            "dispatches.last path gives wrong result when dispatch-1 is opened")
        XCTAssertNotEqual(childrenViaOpenedId[0].agentId, childrenViaLast[0].agentId,
            "opened-id path and last-id path must diverge — proving the fix is load-bearing")
    }

    // MARK: - Snapshot persistence: agentStates round-trip

    /// agentStates is now persisted in ConversationInstanceInfo (CodingKeys includes
    /// it). A snapshot decoded from JSON must carry agent states so dispatch
    /// popup/breadcrumb resolution by dispatchId works before the engine re-emits
    /// live events. Pre-fix snapshots without the field decode cleanly (nil/empty).
    func testAgentStatesPersistenceRoundTrip() throws {
        // Build a pill via JSON — the same path the engine uses.
        let raw: [String: Any] = [
            "id": "pill-1",
            "name": "dev-lead",
            "status": "done",
            "metadata": [
                "displayName": "Dev Lead",
                "type": "specialist",
                "visibility": "ephemeral",
                "invited": false,
                "dispatchDepth": 1,
                "dispatchParentId": "",
                "dispatches": [
                    [
                        "id": "d-persist-1",
                        "task": "build feature",
                        "model": "opus",
                        "conversationId": "conv-p-1",
                        "status": "done",
                        "elapsed": 10.5,
                    ] as [String: Any],
                ],
            ] as [String: Any],
        ]
        let firstEncoding = try JSONSerialization.data(withJSONObject: raw)
        let pill = try JSONDecoder().decode(AgentStateUpdate.self, from: firstEncoding)

        XCTAssertEqual(pill.dispatches.count, 1, "dispatches must decode from wire JSON")
        XCTAssertEqual(pill.dispatches[0].id, "d-persist-1")
        XCTAssertEqual(pill.dispatches[0].conversationId, "conv-p-1")

        // Round-trip through Codable (persist -> reload path).
        let persisted = try JSONEncoder().encode(pill)
        let reloaded = try JSONDecoder().decode(AgentStateUpdate.self, from: persisted)

        XCTAssertEqual(reloaded.name, "dev-lead")
        XCTAssertEqual(reloaded.agentId, "pill-1")
        XCTAssertEqual(reloaded.dispatches.count, 1,
            "dispatches must survive encode/decode so popup resolution by dispatchId works on reload")
        XCTAssertEqual(reloaded.dispatches[0].id, "d-persist-1",
            "dispatch id must survive round-trip")
        XCTAssertEqual(reloaded.dispatches[0].conversationId, "conv-p-1")
        XCTAssertEqual(reloaded.dispatches[0].task, "build feature")
        XCTAssertEqual(reloaded.dispatches[0].elapsed, 10.5)
    }

    // MARK: - Breadcrumb model

    func testBreadcrumbEntryHashable() {
        // Empty dispatchId → identity falls back to conversationId (legacy path).
        let a = BreadcrumbEntry(agentName: "engine-dev", displayName: "Engine Dev", conversationId: "conv-1", dispatchId: "")
        let b = BreadcrumbEntry(agentName: "ios-dev", displayName: "iOS Dev", conversationId: "conv-2", dispatchId: "")
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a.id, "conv-1")
        XCTAssertEqual(b.id, "conv-2")

        // Same conversationId (and empty dispatchId) means same identity.
        let a2 = BreadcrumbEntry(agentName: "engine-dev", displayName: "Engine Dev", conversationId: "conv-1", dispatchId: "")
        XCTAssertEqual(a, a2)

        // Dispatch id takes precedence: two entries sharing a conversationId but
        // carrying distinct dispatch ids are distinct (same-name/same-conv
        // dispatches render independently).
        let d1 = BreadcrumbEntry(agentName: "engine-dev", displayName: "Engine Dev", conversationId: "conv-1", dispatchId: "disp-A")
        let d2 = BreadcrumbEntry(agentName: "engine-dev", displayName: "Engine Dev", conversationId: "conv-1", dispatchId: "disp-B")
        XCTAssertNotEqual(d1, d2)
        XCTAssertEqual(d1.id, "disp-A")
        XCTAssertEqual(d2.id, "disp-B")
    }
}
