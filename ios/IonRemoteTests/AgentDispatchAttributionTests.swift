import XCTest
@testable import IonRemote

/// Tests for the dispatch nesting attribution on `AgentStateUpdate`
/// (`dispatchDepth` / `dispatchParentId`) and the derived `isRootLevel`.
///
/// The engine stamps these onto each agent-state pill at dispatch time
/// (dispatch_agent.go). The main conversation panel filters to root-level
/// agents (`visibleAgents` in ConversationView) so a lead's nested specialists
/// appear only inside the lead's dispatch preview, not the main row.
///
/// **Revert test:** removing `&& $0.isRootLevel` from `visibleAgents`, or the
/// metadata decode in `AgentStateUpdate.init(from:)`, makes
/// `test_nestedDispatch_isNotRootLevel` / `test_visibleAgents_excludesNested`
/// fail because the depth-2 pill would no longer be recognized or filtered.
final class AgentDispatchAttributionTests: XCTestCase {

    /// Build an AgentStateUpdate through the real Codable decoder so we exercise
    /// the metadata decode path. `depth`/`parent` are nil to OMIT the keys.
    private func makeAgent(name: String, depth: Int?, parent: String?) -> AgentStateUpdate {
        var metadata: [String: Any] = [
            "displayName": name.capitalized,
            "type": "specialist",
            "visibility": "always",
            "invited": false,
        ]
        if let depth { metadata["dispatchDepth"] = depth }
        if let parent { metadata["dispatchParentId"] = parent }

        let raw: [String: Any] = [
            "id": "dispatch-\(name)-1",
            "name": name,
            "status": "running",
            "metadata": metadata,
        ]
        let data = try! JSONSerialization.data(withJSONObject: raw)
        return try! JSONDecoder().decode(AgentStateUpdate.self, from: data)
    }

    func test_orchestratorDirectDispatch_isRootLevel() {
        let a = makeAgent(name: "dev-lead", depth: 1, parent: "")
        XCTAssertEqual(a.dispatchDepth, 1)
        XCTAssertEqual(a.dispatchParentId, "")
        XCTAssertTrue(a.isRootLevel)
    }

    func test_nestedDispatch_isNotRootLevel() {
        let a = makeAgent(name: "engine-dev", depth: 2, parent: "dispatch-dev-lead-1")
        XCTAssertEqual(a.dispatchDepth, 2)
        XCTAssertEqual(a.dispatchParentId, "dispatch-dev-lead-1")
        XCTAssertFalse(a.isRootLevel)
    }

    func test_noAttribution_isRootLevel_backCompat() {
        // Extension-roster rows / pre-fix persisted state carry no attribution.
        let a = makeAgent(name: "roster-agent", depth: nil, parent: nil)
        XCTAssertEqual(a.dispatchDepth, 0)
        XCTAssertEqual(a.dispatchParentId, "")
        XCTAssertTrue(a.isRootLevel)
    }

    /// Per-instance: a depth-2 pill is excluded from the root-level set even when
    /// another pill of the SAME name is depth-1. (A name-aggregate heuristic
    /// could not distinguish these.)
    func test_perInstance_sameNameDifferentDepth() {
        let root = makeAgent(name: "worker", depth: 1, parent: "")
        let nested = makeAgent(name: "worker", depth: 2, parent: "dispatch-lead-1")
        XCTAssertTrue(root.isRootLevel)
        XCTAssertFalse(nested.isRootLevel)
    }

    /// Mirrors ConversationView.visibleAgents' root-level filter: a depth-2
    /// dispatch is excluded from the main panel; the depth-1 lead stays.
    func test_visibleAgents_excludesNested() {
        let lead = makeAgent(name: "dev-lead", depth: 1, parent: "")
        let nested = makeAgent(name: "engine-dev", depth: 2, parent: "dispatch-dev-lead-1")
        let filtered = [lead, nested].filter { $0.isVisible && $0.isRootLevel }
        XCTAssertEqual(filtered.map(\.name), ["dev-lead"])
    }
}
