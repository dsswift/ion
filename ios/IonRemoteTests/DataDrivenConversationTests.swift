import XCTest
@testable import IonRemote

/// #256 follow-up: "the only difference between a plain and an extension-backed
/// conversation must be DATA, never a code fork on tab type."
///
/// These tests pin the three illegitimate tab-type forks that were collapsed:
///
///   1. Agent panel — now gated purely on `!visibleAgents.isEmpty` (data), so a
///      plain conversation that dispatches background sub-agents shows them.
///   2. Snapshot projection — a plain tab (hasEngineExtension == false / absent)
///      that carries `conversationInstances` now gets them populated, including
///      the runtime `agentStates` (via the agent-state event that writes the
///      single instance) and the projected `runningAgentCount`.
///   3. Submit / setModel — single branch-free path, same wire command for
///      every tab type (the wire-command identity is pinned in
///      UnifiedSubmitPathTests; here we pin the data-population half).
@MainActor
final class DataDrivenConversationTests: XCTestCase {

    // MARK: - Helpers

    private func makeTab(id: String, engine: Bool) -> RemoteTabState {
        RemoteTabState(
            id: id,
            title: id,
            customTitle: nil,
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: [],
            hasEngineExtension: engine
        )
    }

    /// Decode an `AgentStateUpdate` from the engine wire shape. `AgentStateUpdate`
    /// has only a decoding initializer, so we build one from JSON. visibility
    /// "always" makes `isVisible` true regardless of status.
    private func alwaysVisibleAgent(name: String) throws -> AgentStateUpdate {
        let json = """
        {"id":"\(name)","name":"\(name)","status":"running",
         "metadata":{"displayName":"\(name)","visibility":"always","type":"specialist","invited":true}}
        """.data(using: .utf8)!
        return try JSONDecoder().decode(AgentStateUpdate.self, from: json)
    }

    // MARK: - 1. Agent panel is data-driven (source guard + data plumbing)

    /// The agent panel renders off `visibleAgents`, which is derived from the
    /// tab's single conversation instance `agentStates` — with NO tab-type
    /// gate. A plain tab (hasEngineExtension == false) with a non-empty,
    /// visible agents list must surface them.
    func testVisibleAgentsPopulatedForPlainTabWithAgentStates() throws {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "plain", engine: false)]
        // Drive the real agent-state event handler. It writes the single
        // conversation instance via mutateEngineInstance (no tab-type check),
        // so a plain tab gets agentStates just like an engine tab.
        let agent = try alwaysVisibleAgent(name: "Researcher")
        vm.handleEvent(.engineAgentState(tabId: "plain", instanceId: nil, agents: [agent]))

        let instance = try XCTUnwrap(vm.conversationInstances["plain"]?.first,
            "mutateEngineInstance must create the single instance for a plain tab")
        XCTAssertEqual(instance.agentStates.count, 1)
        // The view's `visibleAgents` filter is `agentStates.filter(\.isVisible)`;
        // an "always"-visibility agent is visible, so the panel would render.
        XCTAssertTrue(instance.agentStates.contains(where: { $0.isVisible }),
            "A plain tab with a visible dispatched agent must drive the agent panel — no tab-type gate")
    }

    /// Source-level guard: the agent-panel render site must NOT branch on
    /// `tabHasExtensions`. (SwiftUI bodies aren't introspectable; this pins the
    /// declaration site, mirroring MergedConversationViewTests.)
    func testAgentPanelRenderSiteHasNoTabTypeFork() throws {
        let src = try viewSource("ConversationView.swift")
        XCTAssertFalse(src.contains("tabHasExtensions && !visibleAgents.isEmpty"),
            "Agent panel must not be gated on tabHasExtensions — it is data-driven (#256 follow-up)")
        // The render site passes agents via a ternary on visibleAgents.isEmpty, not an `if` branch.
        // Pinning this exact form ensures no one silently reverts to a tab-type fork.
        XCTAssertTrue(src.contains("agents: visibleAgents.isEmpty ? nil : visibleAgents"),
            "Agent panel render site must pass agents via the data-driven ternary: visibleAgents.isEmpty ? nil : visibleAgents")
        // If someone reintroduced a tab-type fork they would combine tabHasExtensions with visibleAgents.
        XCTAssertFalse(src.contains("tabHasExtensions && visibleAgents.isEmpty"),
            "No tab-type guard may gate the visibleAgents.isEmpty ternary")
    }

    // MARK: - 2. Snapshot populates conversationInstances for a PLAIN tab

    /// Before the #256 follow-up, the snapshot projection was gated on
    /// `tab.hasEngineExtension == true`, so a plain tab's conversationInstances
    /// (carrying runningAgentCount and the active-instance pointer) were
    /// dropped. The gate is now "has instances" — DATA, not tab type — so a
    /// plain tab gets them populated.
    func testSnapshotPopulatesConversationInstancesForPlainTab() throws {
        let vm = SessionViewModel()
        // Plain tab: hasEngineExtension absent from the wire payload entirely.
        let json = """
        {"type":"desktop_snapshot","tabs":[
          {"id":"plain","title":"Plain","customTitle":null,"status":"running",
           "workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],
           "lastMessage":null,"contextTokens":null,
           "conversationInstances":[{"id":"main","label":"Main","runningAgentCount":2}],
           "activeConversationInstanceId":"main"}
        ]}
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _) = event else {
            return XCTFail("Expected snapshot")
        }
        // Sanity: the wire payload really is a plain tab.
        XCTAssertNotEqual(tabs.first?.hasEngineExtension, true,
            "Fixture must represent a plain tab (no extension flag)")

        vm.handleSnapshot(snapshotTabs: tabs, recentDirs: [], groupMode: nil, groups: nil)

        let instances = try XCTUnwrap(vm.conversationInstances["plain"],
            "A plain tab carrying conversationInstances must get them merged post-#256-follow-up — the former hasEngineExtension gate dropped them")
        XCTAssertEqual(instances.count, 1)
        XCTAssertEqual(instances.first?.id, "main")
        XCTAssertEqual(instances.first?.runningAgentCount, 2,
            "Projected runningAgentCount must survive the merge for a plain tab")
        XCTAssertEqual(vm.activeEngineInstance["plain"], "main",
            "Active instance pointer must be resolved for a plain tab too")
    }

    /// The runtime-state-preserving merge (the every-5s-flicker fix) must still
    /// hold for a plain tab: a second snapshot updates the projected fields but
    /// keeps the runtime messages/agentStates already on the instance.
    func testSnapshotMergePreservesRuntimeStateForPlainTab() throws {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "plain", engine: false)]
        // Seed runtime state on the single instance (as if from live events).
        vm.conversationInstances["plain"] = [
            ConversationInstanceInfo(id: "main", label: "Main")
        ]
        vm.mutateConversationMessages(tabId: "plain") {
            $0.append(Message(id: "m1", role: .user, content: "hi", timestamp: 1))
        }
        let agent = try alwaysVisibleAgent(name: "Worker")
        vm.handleEvent(.engineAgentState(tabId: "plain", instanceId: nil, agents: [agent]))

        // Snapshot updates a projected field (runningAgentCount) on the same id.
        let json = """
        {"type":"desktop_snapshot","tabs":[
          {"id":"plain","title":"Plain","customTitle":null,"status":"running",
           "workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],
           "lastMessage":null,"contextTokens":null,
           "conversationInstances":[{"id":"main","label":"Main","runningAgentCount":3}],
           "activeConversationInstanceId":"main"}
        ]}
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _) = event else {
            return XCTFail("Expected snapshot")
        }
        vm.handleSnapshot(snapshotTabs: tabs, recentDirs: [], groupMode: nil, groups: nil)

        let instance = try XCTUnwrap(vm.conversationInstances["plain"]?.first)
        // Projected field updated…
        XCTAssertEqual(instance.runningAgentCount, 3)
        // …while runtime state survived (no flicker regression).
        XCTAssertEqual(instance.messages.count, 1, "Runtime messages must survive the snapshot merge")
        XCTAssertEqual(instance.agentStates.count, 1, "Runtime agentStates must survive the snapshot merge")
    }

    // MARK: - helpers (source guards)

    private func viewSource(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }
}
