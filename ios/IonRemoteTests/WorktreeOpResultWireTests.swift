import XCTest
@testable import IonRemote

/// Worktree/bench OPERATION RESULT wire parity (`desktop_worktree_op_result`).
///
/// Split from WorktreeWireTests.swift, which reached the file-size cap. Same
/// contract, same lockstep rule: the desktop owns the wire and these pin the
/// decode of every field a toast renders — ok/error, the refusal-vs-failure
/// distinction, the assemble vocabulary, and the dry-run collision warning.
final class WorktreeOpResultWireTests: XCTestCase {

    func testOpResultDistinguishesRefusalFromFailure() throws {
        let refused = """
        {"type":"desktop_worktree_op_result","ok":false,"operation":"sync",
         "error":"uncommitted changes","refusedDirty":true}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: refused)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.operation, .sync)
        XCTAssertEqual(result.refusedDirty, true)
        XCTAssertNil(result.hasConflicts)
    }

    func testOpResultUpdateAllUsesSnakeCaseOnTheWire() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"update_all"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .updateAll)
        XCTAssertTrue(result.ok)
    }

    func testEventsRoundTrip() throws {
        let original = RemoteEvent.worktreeOpResult(result: RemoteWorktreeOpResult(
            ok: false, operation: .landAndRetire, error: "conflict", refusedDirty: nil, hasConflicts: true))

        let decoded = try JSONDecoder().decode(
            RemoteEvent.self, from: try JSONEncoder().encode(original))

        guard case let .worktreeOpResult(result) = decoded else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .landAndRetire)
        XCTAssertEqual(result.hasConflicts, true)
        XCTAssertEqual(result.error, "conflict")
    }

    /// Regression: the desktop answers a land with `operation:"land_and_retire"`.
    /// The Swift enum used to carry a stale `land` raw value that never matched,
    /// so every successful land fell through the unknown-operation fallback and
    /// toasted "Bench assembled." This pins the real wire string.
    func testLandAndRetireResultDecodesToItsOwnCase() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"land_and_retire"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .landAndRetire)
        XCTAssertNotEqual(result.operation, .assemble)
    }

    /// The AI-assisted resolver answers as `conflict_assist` with the resolver
    /// conversation's tabId, and a remote pipeline start acknowledges as
    /// `pipeline_start` (ok or refused-because-running).
    func testConflictAssistAndPipelineStartDecode() throws {
        let assist = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"conflict_assist","tabId":"tab-9"}
        """.data(using: .utf8)!
        guard case let .worktreeOpResult(assistResult) = try JSONDecoder().decode(RemoteEvent.self, from: assist) else {
            return XCTFail("wrong case")
        }
        XCTAssertEqual(assistResult.operation, .conflictAssist)
        XCTAssertEqual(assistResult.tabId, "tab-9")

        let refused = """
        {"type":"desktop_worktree_op_result","ok":false,"operation":"pipeline_start",
         "error":"A sync pipeline is already running."}
        """.data(using: .utf8)!
        guard case let .worktreeOpResult(startResult) = try JSONDecoder().decode(RemoteEvent.self, from: refused) else {
            return XCTFail("wrong case")
        }
        XCTAssertEqual(startResult.operation, .pipelineStart)
        XCTAssertFalse(startResult.ok)
    }

    /// The pin-update dry-run's collision prediction: the operation SUCCEEDED
    /// (`ok: true`) and the warning names what the next assembly will hit.
    /// Both facts must survive the decode — collapsing this into a failure
    /// would tell the operator the update did not happen.
    func testOpResultCarriesDryRunWarningOnSuccess() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"update",
         "warning":"Updating wt/a will conflict on src/a.ts at the next assembly."}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.operation, .update)
        XCTAssertEqual(result.warning,
                       "Updating wt/a will conflict on src/a.ts at the next assembly.")
    }

    /// `assemble` is the wire vocabulary (lockstep rename from `rebuild`); an
    /// unknown operation from a newer desktop degrades to `.assemble` rather
    /// than failing the frame.
    func testNewRemoteOperationNamesDecode() throws {
        let names: [(String, RemoteWorktreeOpResult.Operation)] = [
            ("create", .create), ("convert", .convert), ("rename", .rename),
            ("reprovision", .reprovision), ("recover_conflict", .recoverConflict),
            ("analyse_verification", .analyseVerification), ("discard_recordings", .discardRecordings),
        ]
        for (raw, expected) in names {
            let json = "{\"type\":\"desktop_worktree_op_result\",\"ok\":true,\"operation\":\"\(raw)\"}".data(using: .utf8)!
            let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
            guard case let .worktreeOpResult(result) = event else { return XCTFail("expected operation result") }
            XCTAssertEqual(result.operation, expected)
        }
    }

    func testOpResultAssembleOperationDecodes() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"assemble"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .assemble)
    }

    /// The bulk sync pass: `sync_all` decodes with its pre-worded summary, and
    /// conflicts surviving the pass ride `hasConflicts` on an ok:true result
    /// (the pass ran to completion; the conflicts are its honest outcome).
    func testOpResultSyncAllCarriesSummary() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"sync_all",
         "hasConflicts":true,"summary":"3 synced, 2 completed by replay, 1 conflicted"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.operation, .syncAll)
        XCTAssertEqual(result.hasConflicts, true)
        XCTAssertEqual(result.summary, "3 synced, 2 completed by replay, 1 conflicted")
    }

    /// Unknown-source worktrees are skipped by sync-all; the summary wording
    /// must decode so the iOS toast renders the operator-facing sentence.
    func testSyncAllWithUnknownSourceSkips() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"sync_all",
         "summary":"2 synced, 1 skipped (unknown source)"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.operation, .syncAll)
        XCTAssertEqual(result.summary, "2 synced, 1 skipped (unknown source)")
    }

    func testOpResultRetireDecodes() throws {
        let json = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"retire"}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeOpResult(result) = event else { return XCTFail("wrong case") }
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.operation, .retire)
    }

    /// `retire_all` decodes with its `retired` count, on both a full success
    /// and a partial-batch failure -- the count is the only signal that tells
    /// the operator whether ANYTHING was retired before the batch stopped.
    func testOpResultRetireAllCarriesRetiredCount() throws {
        let ok = """
        {"type":"desktop_worktree_op_result","ok":true,"operation":"retire_all","retired":3}
        """.data(using: .utf8)!

        let okEvent = try JSONDecoder().decode(RemoteEvent.self, from: ok)
        guard case let .worktreeOpResult(okResult) = okEvent else { return XCTFail("wrong case") }
        XCTAssertTrue(okResult.ok)
        XCTAssertEqual(okResult.operation, .retireAll)
        XCTAssertEqual(okResult.retired, 3)

        let partial = """
        {"type":"desktop_worktree_op_result","ok":false,"operation":"retire_all",
         "error":"disk busy","retired":1}
        """.data(using: .utf8)!

        let partialEvent = try JSONDecoder().decode(RemoteEvent.self, from: partial)
        guard case let .worktreeOpResult(partialResult) = partialEvent else { return XCTFail("wrong case") }
        XCTAssertFalse(partialResult.ok)
        XCTAssertEqual(partialResult.operation, .retireAll)
        XCTAssertEqual(partialResult.retired, 1)
        XCTAssertEqual(partialResult.error, "disk busy")
    }

    /// The summary survives a round-trip, so a relayed frame loses nothing.
    func testSyncAllSummaryRoundTrips() throws {
        let original = RemoteEvent.worktreeOpResult(result: RemoteWorktreeOpResult(
            ok: true, operation: .syncAll, error: nil, refusedDirty: nil,
            hasConflicts: nil, warning: nil, summary: "All worktrees already current"))

        let decoded = try JSONDecoder().decode(
            RemoteEvent.self, from: try JSONEncoder().encode(original))

        guard case let .worktreeOpResult(result) = decoded else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .syncAll)
        XCTAssertEqual(result.summary, "All worktrees already current")
    }
}

extension WorktreeOpResultWireTests {
    /// Open results identify exact tab desktop created or focused. The phone must
    /// navigate by this authoritative id, never guess from worktree state.
    func testOpenResultCarriesTabIdAndFailure() throws {
        let success = #"{"type":"desktop_worktree_op_result","ok":true,"operation":"open","tabId":"tab-123"}"#
            .data(using: .utf8)!
        let failure = #"{"type":"desktop_worktree_op_result","ok":false,"operation":"open","error":"This worktree has landed and is sealed for review."}"#
            .data(using: .utf8)!

        guard case let .worktreeOpResult(opened) = try JSONDecoder().decode(RemoteEvent.self, from: success) else {
            return XCTFail("wrong success case")
        }
        XCTAssertTrue(opened.ok)
        XCTAssertEqual(opened.operation, .open)
        XCTAssertEqual(opened.tabId, "tab-123")

        guard case let .worktreeOpResult(refused) = try JSONDecoder().decode(RemoteEvent.self, from: failure) else {
            return XCTFail("wrong failure case")
        }
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.operation, .open)
        XCTAssertEqual(refused.error, "This worktree has landed and is sealed for review.")
        XCTAssertNil(refused.tabId)
    }

    /// Retire recovery and bench pruning are distinct facts. Losing either
    /// strand leaves phone unable to tell operator what desktop preserved.
    func testRetireResultCarriesRecoveryAndPrunedBenches() throws {
        let json = #"{"type":"desktop_worktree_op_result","ok":true,"operation":"retire","recoveryRef":"refs/ion/recovery/abc","prunedBenchPaths":["/bench/a","/bench/b"]}"#
            .data(using: .utf8)!

        guard case let .worktreeOpResult(result) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            return XCTFail("wrong case")
        }
        XCTAssertEqual(result.recoveryRef, "refs/ion/recovery/abc")
        XCTAssertEqual(result.prunedBenchPaths, ["/bench/a", "/bench/b"])
    }

    @MainActor
    func testOpenResultNavigatesAndLandedRefusalDoesNot() {
        let viewModel = SessionViewModel()
        viewModel.handleWorktreeOpResult(RemoteWorktreeOpResult(
            ok: true, operation: .open, error: nil, tabId: "tab-123"))
        XCTAssertEqual(viewModel.pendingNavigationTabId, "tab-123")

        viewModel.pendingNavigationTabId = nil
        viewModel.handleWorktreeOpResult(RemoteWorktreeOpResult(
            ok: false, operation: .open,
            error: "This worktree has landed and is sealed for review."))
        XCTAssertNil(viewModel.pendingNavigationTabId)
        XCTAssertEqual(viewModel.gitToast?.message, "This worktree has landed and is sealed for review.")
        XCTAssertTrue(viewModel.gitToast?.isError == true)
    }

    func testUnknownConversationRoleUsesHonestFallbackLabel() {
        let unknown = RemoteOpenConversation(tabId: "tab", title: "", status: "idle", index: 1,
                                             tabRole: "future-role")
        let absent = RemoteOpenConversation(tabId: "tab", title: "", status: "idle", index: 1,
                                            tabRole: nil)
        let known = RemoteOpenConversation(tabId: "tab", title: "", status: "idle", index: 1,
                                           tabRole: "conflict-auto-fix")

        XCTAssertEqual(unknown.roleLabel, "Other")
        XCTAssertNil(absent.roleLabel)
        XCTAssertEqual(known.roleLabel, "Auto-fix")
    }

    func testInputLockReasonsRenderDistinctOperatorNotices() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/ConversationView+InputBar.swift")
        let source = try String(contentsOf: url, encoding: .utf8)

        XCTAssertTrue(source.contains("Landed worktree review — input is disabled."))
        XCTAssertTrue(source.contains("Automated fix conversation — input is disabled."))
        XCTAssertTrue(source.contains("inputLockReason == \"landed-worktree\""))
        // Settled conversations show a distinct notice with an Un-settle action.
        XCTAssertTrue(source.contains("inputLockReason == \"settled\""),
            "settled lock reason must branch to a distinct notice")
        XCTAssertTrue(source.contains("Settled — input is paused."),
            "settled notice must carry the settled-specific copy")
        XCTAssertTrue(source.contains("unsettleTab(tabId:"),
            "settled notice must offer an Un-settle action")
    }

    func testTabRowUsesTerminalLandAndRetireAction() throws {
        let source = try tabRowContextMenuSource()

        XCTAssertTrue(source.contains("viewModel.landAndRetireWorktree(wt, repoPath: state.repoPath)"))
        XCTAssertTrue(source.contains("Land and retire into \\(source)"))
        XCTAssertFalse(source.contains("confirmRetire"))
        XCTAssertFalse(source.contains("Retire worktree"))
    }

    private func tabRowContextMenuSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/TabRowContextMenu.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }
}
