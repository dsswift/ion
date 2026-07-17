import XCTest
@testable import IonRemote

// MARK: - ContextBreakdownDecodeTests
//
// Tests for:
//   1. desktop_context_breakdown TypeKey decode (Step 9 wire).
//   2. RemoteEvent round-trip: encode → decode produces identical payload.
//   3. Cold-start: RemoteTabState optional cost/token fields decode and default to nil.
//   4. Cold-start tier-3 breadcrumb reconstruction via buildBreadcrumbPathForTest.
//      (Step 9a – mirrors ConversationView+Presentation.buildBreadcrumbPath)
//   5. Running-only flat dispatch list: only running agents appear.
//
// Run with:
//   cd ios && xcodebuild test -project IonRemote.xcodeproj -scheme IonRemote \
//     -destination 'platform=iOS Simulator,name=iPhone 15' \
//     -only-testing IonRemoteTests/ContextBreakdownDecodeTests

final class ContextBreakdownDecodeTests: XCTestCase {

    // MARK: - Helpers

    private func decodeAgent(_ json: String) throws -> AgentStateUpdate {
        try JSONDecoder().decode(AgentStateUpdate.self, from: json.data(using: .utf8)!)
    }

    // MARK: - 1. TypeKey decode: desktop_context_breakdown

    func test_desktopContextBreakdown_decodes() throws {
        let json = """
        {
            "type": "desktop_context_breakdown",
            "tabId": "tab-abc",
            "instanceId": "inst-001",
            "contextBreakdown": {
                "categories": [
                    { "name": "System Prompt", "kind": "system",       "tokens": 1500, "tier": "exact" },
                    { "name": "Conversation",  "kind": "conversation", "tokens": 8000, "tier": "local" },
                    { "name": "Tools",         "kind": "tools",        "tokens": 3200, "tier": "exact" }
                ],
                "contextWindow": 200000,
                "totalTokens": 12700,
                "apiReportedTotal": 12850,
                "unaccounted": 150,
                "model": "claude-sonnet-4-6"
            }
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case .desktopContextBreakdown(
            let tabId, let instanceId, let payload
        ) = event else {
            XCTFail("Expected .desktopContextBreakdown, got: \(event)")
            return
        }

        XCTAssertEqual(tabId, "tab-abc")
        XCTAssertEqual(instanceId, "inst-001")
        XCTAssertEqual(payload.categories.count, 3)
        XCTAssertEqual(payload.categories[0].name, "System Prompt")
        XCTAssertEqual(payload.categories[0].tier, "exact")
        XCTAssertEqual(payload.categories[0].tokens, 1500)
        XCTAssertEqual(payload.categories[1].kind, "conversation")
        XCTAssertEqual(payload.contextWindow, 200_000)
        XCTAssertEqual(payload.totalTokens, 12_700)
        XCTAssertEqual(payload.apiReportedTotal, 12_850)
        XCTAssertEqual(payload.unaccounted, 150)
        XCTAssertEqual(payload.model, "claude-sonnet-4-6")
    }

    // MARK: - 1b. No instanceId — decodes with nil instanceId

    func test_desktopContextBreakdown_nilInstanceId() throws {
        let json = """
        {
            "type": "desktop_context_breakdown",
            "tabId": "tab-noinstance",
            "contextBreakdown": {
                "categories": [],
                "contextWindow": 100000,
                "totalTokens": 0,
                "model": "claude-haiku-3"
            }
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .desktopContextBreakdown(_, let instanceId, _) = event else {
            XCTFail("Expected .desktopContextBreakdown"); return
        }
        XCTAssertNil(instanceId)
    }

    // MARK: - 1c. Per-file row with path field

    func test_desktopContextBreakdown_fileRowWithPath() throws {
        let json = """
        {
            "type": "desktop_context_breakdown",
            "tabId": "tab-files",
            "contextBreakdown": {
                "categories": [
                    { "name": "SessionViewModel.swift", "kind": "file", "tokens": 4200,
                      "tier": "local", "path": "/Users/josh/src/IonRemote/SessionViewModel.swift" }
                ],
                "contextWindow": 200000,
                "totalTokens": 4200,
                "model": "claude-opus-4"
            }
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .desktopContextBreakdown(_, _, let payload) = event else {
            XCTFail("Expected .desktopContextBreakdown"); return
        }
        let cat = try XCTUnwrap(payload.categories.first)
        XCTAssertEqual(cat.kind, "file")
        XCTAssertEqual(cat.path, "/Users/josh/src/IonRemote/SessionViewModel.swift")
    }

    // MARK: - 2. Round-trip encode → decode

    func test_desktopContextBreakdown_roundTrip() throws {
        let original = RemoteEvent.desktopContextBreakdown(
            tabId: "tab-roundtrip",
            instanceId: "inst-rt",
            contextBreakdown: ContextBreakdownPayload(
                categories: [
                    ContextBreakdownCategory(
                        name: "System Prompt", kind: "system", tokens: 2000, tier: "exact", path: nil
                    ),
                    ContextBreakdownCategory(
                        name: "file.swift", kind: "file", tokens: 500, tier: "local",
                        path: "/Users/josh/project/file.swift"
                    )
                ],
                contextWindow: 100_000,
                totalTokens: 2500,
                apiReportedTotal: nil,
                unaccounted: nil,
                model: "claude-opus-4",
                cacheReadTokens: nil,
                cacheCreationTokens: nil,
                aggregateCostUsd: nil,
                modelBreakdown: nil
            )
        )

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(RemoteEvent.self, from: encoded)

        guard case .desktopContextBreakdown(
            let tabId, let instanceId, let payload
        ) = decoded else {
            XCTFail("Round-trip failed: got \(decoded)")
            return
        }

        XCTAssertEqual(tabId, "tab-roundtrip")
        XCTAssertEqual(instanceId, "inst-rt")
        XCTAssertEqual(payload.categories.count, 2)
        XCTAssertEqual(payload.categories[1].path, "/Users/josh/project/file.swift")
        XCTAssertNil(payload.apiReportedTotal)
        XCTAssertNil(payload.unaccounted)
        XCTAssertEqual(payload.model, "claude-opus-4")
    }

    // MARK: - 3. Cold-start: RemoteTabState cost/token optionals decode correctly

    private func minimalTab(extra: String = "") -> Data {
        """
        { "id": "tab-cold", "title": "Cold Tab", "status": "idle",
          "workingDirectory": "/tmp", "permissionMode": "auto",
          "permissionQueue": []
          \(extra.isEmpty ? "" : ", \(extra)")
        }
        """.data(using: .utf8)!
    }

    func test_remoteTabState_coldStart_tokenFields_nil_by_default() throws {
        // A tab that has never run should have nil cost/token fields.
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: minimalTab())
        XCTAssertNil(tab.totalCostUsd,       "Cold tab: totalCostUsd should be nil")
        XCTAssertNil(tab.inputTokens,         "Cold tab: inputTokens should be nil")
        XCTAssertNil(tab.outputTokens,        "Cold tab: outputTokens should be nil")
        XCTAssertNil(tab.cacheReadTokens,     "Cold tab: cacheReadTokens should be nil")
        XCTAssertNil(tab.cacheCreationTokens, "Cold tab: cacheCreationTokens should be nil")
    }

    func test_remoteTabState_snapshotCost_decodes() throws {
        // A tab that has run carries cost/token fields from the desktop snapshot.
        let data = minimalTab(extra: """
            "totalCostUsd": 0.0042,
            "inputTokens": 12000,
            "outputTokens": 3500,
            "cacheReadTokens": 8000,
            "cacheCreationTokens": 4000
        """)
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.totalCostUsd ?? 0, 0.0042, accuracy: 0.00001)
        XCTAssertEqual(tab.inputTokens,        12_000)
        XCTAssertEqual(tab.outputTokens,       3_500)
        XCTAssertEqual(tab.cacheReadTokens,    8_000)
        XCTAssertEqual(tab.cacheCreationTokens, 4_000)
    }

    // MARK: - 4. Tier-3 breadcrumb reconstruction (Step 9a)
    //
    // Verifies that buildBreadcrumbPathForTest (which mirrors
    // ConversationView+Presentation.buildBreadcrumbPath) produces the correct
    // root → tier-2 → tier-3 ancestor chain with the root entry dropped.
    // The test uses JSON-decoded AgentStateUpdate values (via the real Codable
    // init) to guarantee the same code path used at runtime.

    func test_buildBreadcrumbPath_tier3() throws {
        let rootAgent = try decodeAgent("""
        {
            "name": "orchestrator",
            "status": "done",
            "metadata": {
                "displayName": "Orchestrator",
                "type": "chief",
                "visibility": "always",
                "dispatchDepth": 0,
                "dispatchParentId": "",
                "dispatches": [
                    { "id": "d-root", "task": "root task", "model": "claude-opus-4",
                      "conversationId": "c-root", "status": "done" }
                ]
            }
        }
        """)

        let tier2Agent = try decodeAgent("""
        {
            "name": "researcher",
            "status": "done",
            "metadata": {
                "displayName": "Researcher",
                "type": "specialist",
                "visibility": "ephemeral",
                "dispatchDepth": 1,
                "dispatchParentId": "d-root",
                "dispatches": [
                    { "id": "d-tier2", "task": "research", "model": "claude-sonnet-4-6",
                      "conversationId": "c-tier2", "status": "done" }
                ]
            }
        }
        """)

        let tier3Agent = try decodeAgent("""
        {
            "name": "sub-researcher",
            "status": "running",
            "metadata": {
                "displayName": "Sub-Researcher",
                "type": "specialist",
                "visibility": "ephemeral",
                "dispatchDepth": 2,
                "dispatchParentId": "d-tier2",
                "dispatches": [
                    { "id": "d-tier3", "task": "sub-research", "model": "claude-haiku-3",
                      "conversationId": "c-tier3", "status": "running" }
                ]
            }
        }
        """)

        let allAgents = [rootAgent, tier2Agent, tier3Agent]
        let path = buildBreadcrumbPathForTest(dispatchId: "d-tier3", allAgents: allAgents)

        // Expected: root dropped; path = [tier-2 entry, tier-3 entry]
        XCTAssertEqual(path.count, 2, "Path should have 2 entries (intermediate + target)")
        XCTAssertEqual(path[0].dispatchId, "d-tier2", "First entry should be tier-2")
        XCTAssertEqual(path[1].dispatchId, "d-tier3", "Second entry should be tier-3 (target)")
        XCTAssertEqual(path[0].agentName,  "researcher")
        XCTAssertEqual(path[1].agentName,  "sub-researcher")
    }

    func test_buildBreadcrumbPath_rootLevel_returnsEmpty() throws {
        let rootAgent = try decodeAgent("""
        {
            "name": "orchestrator",
            "status": "running",
            "metadata": {
                "displayName": "Orchestrator",
                "type": "chief",
                "visibility": "always",
                "dispatchDepth": 0,
                "dispatchParentId": "",
                "dispatches": [
                    { "id": "d-root", "task": "root task", "model": "claude-opus-4",
                      "conversationId": "c-root", "status": "running" }
                ]
            }
        }
        """)

        let path = buildBreadcrumbPathForTest(dispatchId: "d-root", allAgents: [rootAgent])
        // Root-level dispatch: root is dropped, leaves an empty path.
        XCTAssertEqual(path.count, 0, "Root-level dispatch should have empty ancestor path")
    }

    // MARK: - 5. Running-only flat dispatch list (mirrors StatusDrawerView.runningDispatches)

    func test_runningDispatches_filtersByStatus() throws {
        let runningAgent = try decodeAgent("""
        {
            "name": "agent-A",
            "status": "running",
            "metadata": {
                "displayName": "Agent A",
                "type": "specialist",
                "visibility": "ephemeral",
                "dispatchDepth": 0,
                "dispatchParentId": "",
                "dispatches": [
                    { "id": "d-running", "task": "t", "model": "m",
                      "conversationId": "c1", "status": "running" }
                ]
            }
        }
        """)

        let doneAgent = try decodeAgent("""
        {
            "name": "agent-B",
            "status": "done",
            "metadata": {
                "displayName": "Agent B",
                "type": "specialist",
                "visibility": "ephemeral",
                "dispatchDepth": 0,
                "dispatchParentId": "",
                "dispatches": [
                    { "id": "d-done", "task": "t", "model": "m",
                      "conversationId": "c2", "status": "done" }
                ]
            }
        }
        """)

        let agents = [runningAgent, doneAgent]

        // Mirrors StatusDrawerView.runningDispatches computed var.
        let running = agents.compactMap { agent -> (AgentStateUpdate, DispatchInfo)? in
            guard agent.status == "running" else { return nil }
            let active = agent.dispatches.first(where: { $0.status == "running" })
                ?? agent.dispatches.last
            guard let d = active else { return nil }
            return (agent, d)
        }

        XCTAssertEqual(running.count, 1)
        XCTAssertEqual(running[0].0.name, "agent-A")
        XCTAssertEqual(running[0].1.id,   "d-running")
    }

    // MARK: - 6. Cache fields decode (minty-grinning-cocoa C7 / C9)

    /// cacheReadTokens / cacheCreationTokens decode from the wire when present.
    func test_desktopContextBreakdown_cacheFields_decode() throws {
        let json = """
        {
            "type": "desktop_context_breakdown",
            "tabId": "tab-cache",
            "contextBreakdown": {
                "categories": [
                    { "name": "Conversation", "kind": "conversation", "tokens": 8000, "tier": "local" }
                ],
                "contextWindow": 200000,
                "totalTokens": 8000,
                "cacheReadTokens": 8000,
                "cacheCreationTokens": 3000,
                "model": "claude-sonnet-4-6"
            }
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .desktopContextBreakdown(_, _, let payload) = event else {
            XCTFail("Expected .desktopContextBreakdown"); return
        }
        XCTAssertEqual(payload.cacheReadTokens, 8000)
        XCTAssertEqual(payload.cacheCreationTokens, 3000)
    }

    /// cacheReadTokens / cacheCreationTokens decode to nil when absent.
    func test_desktopContextBreakdown_cacheFields_nil_when_absent() throws {
        let json = """
        {
            "type": "desktop_context_breakdown",
            "tabId": "tab-nocache",
            "contextBreakdown": {
                "categories": [
                    { "name": "System Prompt", "kind": "system", "tokens": 1500, "tier": "exact" }
                ],
                "contextWindow": 200000,
                "totalTokens": 1500,
                "model": "claude-haiku-3"
            }
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .desktopContextBreakdown(_, _, let payload) = event else {
            XCTFail("Expected .desktopContextBreakdown"); return
        }
        XCTAssertNil(payload.cacheReadTokens)
        XCTAssertNil(payload.cacheCreationTokens)
    }

    // MARK: - 7. Breakdown grouping order matches desktop fixed order (C3/C8)

    /// Pure logic test for the grouping algorithm used by StatusDrawerView's
    /// Context Breakdown section. Groups must appear in the fixed kind order
    /// (system_prompt → tools → conversation → file → unaccounted) regardless
    /// of input order, and rows within each bucket must be sorted descending
    /// by token count. Mirrors desktop groupCategories (StatusDrawer.tsx).
    func test_breakdownGroupOrder_matchesDesktopFixedOrder() throws {
        // Fixed kind order + normalization (mirrors BreakdownKind.order / .key
        // in StatusDrawerView.swift and desktop KIND_ORDER / kindKey).
        let kindOrder = ["system_prompt", "tools", "conversation", "file", "unaccounted"]
        func kindKey(_ kind: String) -> String {
            switch kind {
            case "system_prompt", "system-prompt": return "system_prompt"
            case "tools", "tool":                   return "tools"
            case "conversation", "message":         return "conversation"
            case "file":                            return "file"
            default:                                return "unaccounted"
            }
        }

        // Categories in deliberately shuffled order, with multi-row buckets.
        let categories = [
            ContextBreakdownCategory(name: "some.swift", kind: "file", tokens: 500, tier: "local", path: "/a/some.swift"),
            ContextBreakdownCategory(name: "System Prompt", kind: "system_prompt", tokens: 1500, tier: "exact", path: nil),
            ContextBreakdownCategory(name: "Conversation", kind: "conversation", tokens: 8000, tier: "local", path: nil),
            ContextBreakdownCategory(name: "Tools", kind: "tools", tokens: 3200, tier: "exact", path: nil),
            ContextBreakdownCategory(name: "another.swift", kind: "file", tokens: 200, tier: "local", path: "/a/another.swift"),
            ContextBreakdownCategory(name: "Read", kind: "tool", tokens: 100, tier: "exact", path: nil),
        ]

        let payload = ContextBreakdownPayload(
            categories: categories,
            contextWindow: 200_000,
            totalTokens: 13_500,
            apiReportedTotal: nil,
            unaccounted: nil,
            model: "claude-sonnet-4-6",
            cacheReadTokens: nil,
            cacheCreationTokens: nil,
            aggregateCostUsd: nil,
            modelBreakdown: nil
        )

        // Replicate the grouping algorithm.
        var buckets: [String: [ContextBreakdownCategory]] = [:]
        for cat in payload.categories {
            buckets[kindKey(cat.kind), default: []].append(cat)
        }
        var groups: [(kind: String, categories: [ContextBreakdownCategory])] = []
        for kind in kindOrder {
            guard let items = buckets[kind] else { continue }
            let sorted = items.sorted { $0.tokens > $1.tokens }
            groups.append((kind: kind, categories: sorted))
        }

        // Groups appear in the fixed kind order (only present buckets).
        XCTAssertEqual(groups.map(\.kind), ["system_prompt", "tools", "conversation", "file"])

        // Within each bucket, tokens are sorted descending.
        for group in groups {
            let tokens = group.categories.map(\.tokens)
            XCTAssertEqual(tokens, tokens.sorted(by: >), "Bucket \(group.kind) not descending: \(tokens)")
        }

        // Spot-check the multi-row buckets resolved correctly.
        let toolsBucket = try XCTUnwrap(groups.first(where: { $0.kind == "tools" }))
        XCTAssertEqual(toolsBucket.categories.map(\.tokens), [3200, 100])
        let fileBucket = try XCTUnwrap(groups.first(where: { $0.kind == "file" }))
        XCTAssertEqual(fileBucket.categories.map(\.tokens), [500, 200])
    }
}

// MARK: - Breadcrumb path builder (test-accessible pure function)
//
// Mirrors ConversationView+Presentation.buildBreadcrumbPath.
// Kept as a free function so tests can call it without a SwiftUI view.
// The algorithm must stay in sync with the view extension.

private func buildBreadcrumbPathForTest(
    dispatchId: String,
    allAgents: [AgentStateUpdate]
) -> [BreadcrumbEntry] {
    // Map dispatchId → (owning agent, dispatch).
    var dispatchMap: [String: (AgentStateUpdate, DispatchInfo)] = [:]
    for agent in allAgents {
        for dispatch in agent.dispatches {
            dispatchMap[dispatch.id] = (agent, dispatch)
        }
    }

    guard dispatchMap[dispatchId] != nil else { return [] }

    var chain: [BreadcrumbEntry] = []
    var currentId = dispatchId
    var iterations = 0

    while !currentId.isEmpty, iterations < 20 {
        iterations += 1
        guard let (agent, dispatch) = dispatchMap[currentId] else { break }
        chain.append(BreadcrumbEntry(
            agentName: agent.name,
            displayName: agent.displayName,
            conversationId: dispatch.conversationId,
            dispatchId: dispatch.id
        ))
        let parentId = agent.dispatchParentId
        if parentId.isEmpty { break }
        currentId = parentId
    }

    // Reverse: makes chain root → … → target. Drop root (shown by ADFSV itself).
    return Array(chain.reversed().dropFirst())
}
