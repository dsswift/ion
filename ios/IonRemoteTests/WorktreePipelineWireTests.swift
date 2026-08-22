import XCTest
@testable import IonRemote

/// `desktop_worktree_pipeline` wire parity — the live sync-pipeline banner.
///
/// The desktop pushes one event per phase/progress change; `phase: null`
/// (or absent) is the dismissal signal that clears the banner. Lockstep wire:
/// projectPipelineToWire in useWorktreeRemoteCommandListeners.ts is the
/// producer this pins against.
final class WorktreePipelineWireTests: XCTestCase {

    func testPipelineProgressDecodes() throws {
        let json = """
        {"type":"desktop_worktree_pipeline","repoPath":"/repo","sourceBranch":"josh",
         "phase":"awaiting-ai-confirm","queue":["/wt/a","/wt/b"],"current":null,
         "needsManual":["/wt/c"],"resolvedByAi":2}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreePipeline(pipeline) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(pipeline.repoPath, "/repo")
        XCTAssertEqual(pipeline.sourceBranch, "josh")
        XCTAssertEqual(pipeline.phase, .awaitingAiConfirm)
        XCTAssertEqual(pipeline.queue, ["/wt/a", "/wt/b"])
        XCTAssertNil(pipeline.current)
        XCTAssertEqual(pipeline.needsManual, ["/wt/c"])
        XCTAssertEqual(pipeline.resolvedByAi, 2)
    }

    func testDismissalDecodesAsNilPhase() throws {
        let json = """
        {"type":"desktop_worktree_pipeline","repoPath":"/repo","sourceBranch":null,
         "phase":null,"queue":[],"current":null,"needsManual":[],"resolvedByAi":0}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreePipeline(pipeline) = event else { return XCTFail("wrong case") }
        XCTAssertNil(pipeline.phase, "phase null is the dismissal signal")
    }

    func testTerminalSummaryDecodes() throws {
        let json = """
        {"type":"desktop_worktree_pipeline","repoPath":"/repo","sourceBranch":"josh",
         "phase":"done","queue":[],"current":null,"needsManual":[],"resolvedByAi":3,
         "summary":"5 synced, 3 resolved by AI"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreePipeline(pipeline) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(pipeline.phase, .done)
        XCTAssertEqual(pipeline.summary, "5 synced, 3 resolved by AI")
    }

    /// An unknown phase from a newer desktop degrades to the generic
    /// in-progress rendering rather than failing the frame.
    func testUnknownPhaseDegradesToSyncing() throws {
        let json = """
        {"type":"desktop_worktree_pipeline","repoPath":"/repo","sourceBranch":"josh",
         "phase":"future-phase","queue":[],"current":null,"needsManual":[],"resolvedByAi":0}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreePipeline(pipeline) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(pipeline.phase, .syncing)
    }

    /// Fold semantics: a live phase upserts the repo's entry; a dismissal
    /// removes it.
    @MainActor
    func testViewModelFoldsAndClearsPipelineState() {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreePipeline(RemoteWorktreePipeline(
            repoPath: "/repo", sourceBranch: "josh", phase: .resolving,
            queue: ["/wt/a"], current: "/wt/a", needsManual: [], resolvedByAi: 1, summary: nil))
        XCTAssertEqual(viewModel.worktreePipelines["/repo"]?.phase, .resolving)

        viewModel.handleWorktreePipeline(RemoteWorktreePipeline(
            repoPath: "/repo", sourceBranch: nil, phase: nil,
            queue: [], current: nil, needsManual: [], resolvedByAi: 0, summary: nil))
        XCTAssertNil(viewModel.worktreePipelines["/repo"], "nil phase clears the banner")
    }
}
