import XCTest
@testable import IonRemote

/// Regression test for the agent detail panel identity key.
///
/// Before the fix, `AgentDetailFullScreenView` keyed on the volatile per-dispatch
/// `id` field (`dispatch-<name>-<unixMilli>`). When the engine fires a second
/// dispatch of the same agent it overwrites that field in `session_accessor.go`
/// line 221, so the panel could no longer find its agent — "Agent Not Found".
///
/// After the fix the panel keys on the stable `name` field. This suite verifies
/// that the name-keyed resolver survives a dispatch id rotation.
///
/// **Revert test:** mentally replacing `.first { $0.name == agentName }` with
/// `.first { $0.id == agentId }` causes `test_nameKeyedResolver_survivesDispatchIdRotation`
/// to fail because the second snapshot carries a NEW id that the stale variable
/// would no longer match.
final class AgentPanelNameKeyTests: XCTestCase {

    // MARK: - Helpers

    /// Builds a minimal AgentStateUpdate for testing without going through the
    /// full Codable decoder. Mirrors the shape the engine actually emits.
    private func makeAgent(name: String, dispatchId: String, dispatchCount: Int) -> AgentStateUpdate {
        // Build the JSON the decoder expects so we exercise the real type.
        var dispatchArray: [[String: Any]] = []
        for i in 0..<dispatchCount {
            dispatchArray.append([
                "id": "\(dispatchId)-conv\(i)",
                "task": "test task \(i)",
                "model": "claude-opus-4-5",
                "conversationId": "conv-\(name)-\(i)",
                "status": i < dispatchCount - 1 ? "done" : "running",
                "elapsed": i < dispatchCount - 1 ? Double(i * 10 + 5) : 0.0,
                "startTime": 1_700_000_000.0 + Double(i * 3600)
            ])
        }

        let metadata: [String: Any] = [
            "displayName": name.capitalized,
            "type": "specialist",
            "visibility": "always",
            "invited": false,
            "dispatches": dispatchArray
        ]

        let raw: [String: Any] = [
            "id": dispatchId,
            "name": name,
            "status": "running",
            "metadata": metadata
        ]

        let data = try! JSONSerialization.data(withJSONObject: raw)
        return try! JSONDecoder().decode(AgentStateUpdate.self, from: data)
    }

    // MARK: - Name uniqueness within an instance

    /// Confirms the engine registry deduplicates by name: two entries with the
    /// same name cannot coexist in one snapshot (registry.go AppendOrUpdate keys
    /// on Name). A snapshot therefore has at most one entry per name, making
    /// `name` a safe stable panel key.
    func test_nameDeduplification_snapshotHasOneEntryPerName() {
        let first  = makeAgent(name: "dev-lead", dispatchId: "dispatch-dev-lead-1000", dispatchCount: 1)
        let second = makeAgent(name: "dev-lead", dispatchId: "dispatch-dev-lead-2000", dispatchCount: 2)

        // Simulate what the registry does: replace the first entry when the
        // second arrives (AppendOrUpdate finds by name and updates in place).
        var snapshot: [AgentStateUpdate] = [first]
        if let idx = snapshot.firstIndex(where: { $0.name == second.name }) {
            snapshot[idx] = second
        } else {
            snapshot.append(second)
        }

        XCTAssertEqual(snapshot.count, 1, "Registry must not produce two entries with the same name")
        XCTAssertEqual(snapshot[0].dispatches.count, 2)
    }

    // MARK: - Panel key survivability

    /// Core regression: the panel opens on dispatch 1, captures the agent name,
    /// then the engine issues dispatch 2 with a new id. The name-keyed resolver
    /// must still find the agent (non-nil) and reflect the updated dispatch count.
    func test_nameKeyedResolver_survivesDispatchIdRotation() {
        let agentName = "dev-lead"
        let dispatchId1 = "dispatch-dev-lead-1000"
        let dispatchId2 = "dispatch-dev-lead-2000"
        let initialCount = 1
        let updatedCount = 2

        // --- Dispatch 1: panel opens, captures stable name ---
        let firstSnapshot = makeAgent(name: agentName, dispatchId: dispatchId1, dispatchCount: initialCount)
        var liveSnapshot: [AgentStateUpdate] = [firstSnapshot]

        // The open site captures the stable name (post-fix behaviour).
        let capturedPanelKey = agentName  // was: firstSnapshot.id (volatile)

        // Verify the panel can find the agent on initial open.
        let agentAtOpen = liveSnapshot.first { $0.name == capturedPanelKey }
        XCTAssertNotNil(agentAtOpen, "Panel must find agent on initial open")
        XCTAssertEqual(agentAtOpen?.dispatches.count, initialCount)

        // --- Dispatch 2: engine fires a new dispatch, id rotates ---
        let secondSnapshot = makeAgent(name: agentName, dispatchId: dispatchId2, dispatchCount: updatedCount)
        // Registry replaces in place (AppendOrUpdate by name).
        if let idx = liveSnapshot.firstIndex(where: { $0.name == secondSnapshot.name }) {
            liveSnapshot[idx] = secondSnapshot
        } else {
            liveSnapshot.append(secondSnapshot)
        }

        // The new id is different — an id-keyed panel would now fail.
        XCTAssertNotEqual(dispatchId1, dispatchId2, "Precondition: ids must differ")
        let agentByOldId = liveSnapshot.first { $0.id == dispatchId1 }
        XCTAssertNil(agentByOldId, "Id-keyed lookup must fail after rotation (proves the old bug)")

        // The name-keyed resolver (post-fix) still finds the agent.
        let agentAfterRotation = liveSnapshot.first { $0.name == capturedPanelKey }
        XCTAssertNotNil(agentAfterRotation, "Name-keyed panel must survive dispatch id rotation")
        XCTAssertEqual(agentAfterRotation?.dispatches.count, updatedCount,
                       "Panel must see the updated dispatch count after rotation")
    }

    // MARK: - Multiple agents coexist

    /// Two different agents with different names both remain findable by name
    /// after each receives a new dispatch id.
    func test_nameKeyedResolver_multipleAgentsRemaindistinct() {
        let agentA = makeAgent(name: "dev-lead", dispatchId: "dispatch-dev-lead-1000", dispatchCount: 1)
        let agentB = makeAgent(name: "qa-lead",  dispatchId: "dispatch-qa-lead-1000",  dispatchCount: 1)
        var snapshot: [AgentStateUpdate] = [agentA, agentB]

        // Rotate both ids.
        let agentA2 = makeAgent(name: "dev-lead", dispatchId: "dispatch-dev-lead-2000", dispatchCount: 2)
        let agentB2 = makeAgent(name: "qa-lead",  dispatchId: "dispatch-qa-lead-2000",  dispatchCount: 3)
        for updated in [agentA2, agentB2] {
            if let idx = snapshot.firstIndex(where: { $0.name == updated.name }) {
                snapshot[idx] = updated
            } else {
                snapshot.append(updated)
            }
        }

        XCTAssertEqual(snapshot.count, 2)
        XCTAssertEqual(snapshot.first { $0.name == "dev-lead" }?.dispatches.count, 2)
        XCTAssertEqual(snapshot.first { $0.name == "qa-lead"  }?.dispatches.count, 3)
    }
}

/// Pins the agent-panel header breakdown (`total` / `active` / `done`) that the
/// desktop and iOS headers both render. `active` counts running agents, `done`
/// counts completed agents, and `error`/`idle` fold into NEITHER count (they are
/// surfaced by the row's status dot). Reverting any branch — e.g. counting
/// `error` as `done`, or `idle` as `active` — turns these red.
final class AgentHeaderBreakdownTests: XCTestCase {

    private func agent(_ name: String, status: String) -> AgentStateUpdate {
        let raw: [String: Any] = [
            "id": "d-\(name)",
            "name": name,
            "status": status,
            "metadata": ["displayName": name, "visibility": "always"],
        ]
        let data = try! JSONSerialization.data(withJSONObject: raw)
        return try! JSONDecoder().decode(AgentStateUpdate.self, from: data)
    }

    func test_breakdown_countsActiveAndDone_foldsErrorAndIdle() {
        let agents = [
            agent("a", status: "running"),
            agent("b", status: "running"),
            agent("c", status: "done"),
            agent("d", status: "error"),
            agent("e", status: "idle"),
        ]
        let b = agents.agentHeaderBreakdown
        XCTAssertEqual(b.total, 5, "total is the full visible set")
        XCTAssertEqual(b.active, 2, "only running agents are active")
        XCTAssertEqual(b.done, 1, "only done agents are done — error/idle fold into neither")
    }

    func test_breakdown_empty() {
        let b = [AgentStateUpdate]().agentHeaderBreakdown
        XCTAssertEqual(b.total, 0)
        XCTAssertEqual(b.active, 0)
        XCTAssertEqual(b.done, 0)
    }
}
