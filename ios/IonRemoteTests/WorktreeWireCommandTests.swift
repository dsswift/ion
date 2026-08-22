import XCTest
@testable import IonRemote

/// Worktree + integration bench wire parity — COMMANDS (iOS → desktop).
///
/// Split from WorktreeWireTests.swift (file-size cap) at the natural seam:
/// this half pins command encode/decode/type-string parity; the state-decode
/// half lives in WorktreeWireStateTests.swift. The desktop owns this wire
/// (ADR-008) and it is lockstep: a rename ships to both sides in one change.
final class WorktreeWireCommandTests: XCTestCase {

    // MARK: - Commands (iOS → desktop)

    /// Every command's wire `type` string, asserted literally. A typo here is
    /// invisible until the desktop ignores the frame.
    func testCommandTypeStrings() throws {
        let cases: [(RemoteCommand, String)] = [
            (.worktreeRefresh(repoPath: "/repo"), "desktop_worktree_refresh"),
            (.worktreeOpenConversation(worktreePath: "/wt", newConversation: false),
             "desktop_worktree_open_conversation"),
            (.worktreeSync(worktreePath: "/wt", sourceBranch: "josh", repoPath: "/repo"), "desktop_worktree_sync"),
            (.worktreeSyncAll(repoPath: "/repo"), "desktop_worktree_sync_all"),
            (.worktreeLandAndRetire(repoPath: "/repo", worktreePath: "/wt", worktreeBranch: "wt/a", sourceBranch: "josh"),
             "desktop_worktree_land_and_retire"),
            (.benchOpenConversation(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_open_conversation"),
            (.benchOpenTerminal(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_open_terminal"),
            (.benchAssemble(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_assemble"),
            (.benchUpdateMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt"),
             "desktop_bench_update_member"),
            (.benchUpdateAll(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_update_all"),
            (.worktreeSetStage(repoPath: "/repo", worktreePath: "/wt", stage: "verified"),
             "desktop_worktree_set_stage"),
            (.benchReorderMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt", toIndex: 0),
             "desktop_bench_reorder_member"),
            (.benchAddMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt", branchName: "wt/a"),
             "desktop_bench_add_member"),
            (.benchRemoveMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt"),
             "desktop_bench_remove_member"),
            (.worktreeRetireLanded(repoPath: "/repo"), "desktop_worktree_retire_landed"),
            (.worktreeCreate(repoPath: "/repo", sourceBranch: "josh"), "desktop_worktree_create"),
            (.worktreeConvertConversation(tabId: "tab-1"), "desktop_worktree_convert_conversation"),
            (.worktreeRename(repoPath: "/repo", worktreePath: "/wt", title: "New title"),
             "desktop_worktree_rename"),
            (.worktreeReprovision(repoPath: "/repo", worktreePath: "/wt"), "desktop_worktree_reprovision"),
            (.benchRecoverConflict(repoPath: "/repo", sourceBranch: "josh"),
             "desktop_bench_recover_conflict"),
            (.benchAnalyseVerification(repoPath: "/repo", sourceBranch: "josh"),
             "desktop_bench_analyse_verification"),
            (.benchDiscardMemberRecordings(repoPath: "/repo", sourceBranch: "josh", branchNames: ["wt/a"]),
             "desktop_bench_discard_member_recordings"),
            (.benchDiscardAllRecordings(repoPath: "/repo", sourceBranch: "josh"),
             "desktop_bench_discard_all_recordings"),
            (.worktreeRetire(repoPath: "/repo", worktreePath: "/wt", branchName: "wt/a"),
             "desktop_worktree_retire"),
            (.worktreeConflictAssist(repoPath: "/repo", worktreePath: "/wt"),
             "desktop_worktree_conflict_assist"),
            (.benchConflictAssist(repoPath: "/repo", sourceBranch: "josh"),
             "desktop_bench_conflict_assist"),
            (.worktreePipelineStart(repoPath: "/repo", sourceBranch: "josh"),
             "desktop_worktree_pipeline_start"),
            (.worktreePipelineConfirmAi(repoPath: "/repo"),
             "desktop_worktree_pipeline_confirm_ai"),
            (.worktreePipelineCancel(repoPath: "/repo"),
             "desktop_worktree_pipeline_cancel"),
            (.worktreePipelineDismiss(repoPath: "/repo"),
             "desktop_worktree_pipeline_dismiss"),
        ]

        for (command, expected) in cases {
            let data = try JSONEncoder().encode(command)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(json["type"] as? String, expected, "wrong type string for \(command)")
        }
    }

    func testLandCommandCarriesEveryField() throws {
        let cmd = RemoteCommand.worktreeLandAndRetire(
            repoPath: "/repo", worktreePath: "/wt/a", worktreeBranch: "wt/a3f1", sourceBranch: "josh")

        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try JSONEncoder().encode(cmd)) as? [String: Any])

        XCTAssertEqual(json["repoPath"] as? String, "/repo")
        XCTAssertEqual(json["worktreePath"] as? String, "/wt/a")
        XCTAssertEqual(json["worktreeBranch"] as? String, "wt/a3f1")
        XCTAssertEqual(json["sourceBranch"] as? String, "josh")
    }

    func testNewWorktreeCommandsCarryEveryFieldAndRoundTrip() throws {
        let cases: [(RemoteCommand, (RemoteCommand) -> Bool)] = [
            (.worktreeRetireLanded(repoPath: "/repo"), { if case let .worktreeRetireLanded(repo) = $0 { return repo == "/repo" }; return false }),
            (.worktreeCreate(repoPath: "/repo", sourceBranch: "josh"), { if case let .worktreeCreate(repo, source) = $0 { return repo == "/repo" && source == "josh" }; return false }),
            (.worktreeConvertConversation(tabId: "tab-1"), { if case let .worktreeConvertConversation(tabId) = $0 { return tabId == "tab-1" }; return false }),
            (.worktreeRename(repoPath: "/repo", worktreePath: "/wt", title: "New title"), { if case let .worktreeRename(repo, path, title) = $0 { return repo == "/repo" && path == "/wt" && title == "New title" }; return false }),
            (.worktreeReprovision(repoPath: "/repo", worktreePath: "/wt"), { if case let .worktreeReprovision(repo, path) = $0 { return repo == "/repo" && path == "/wt" }; return false }),
            (.benchRecoverConflict(repoPath: "/repo", sourceBranch: "josh"), { if case let .benchRecoverConflict(repo, source) = $0 { return repo == "/repo" && source == "josh" }; return false }),
            (.benchAnalyseVerification(repoPath: "/repo", sourceBranch: "josh"), { if case let .benchAnalyseVerification(repo, source) = $0 { return repo == "/repo" && source == "josh" }; return false }),
            (.benchDiscardMemberRecordings(repoPath: "/repo", sourceBranch: "josh", branchNames: ["wt/a", "wt/b"]), { if case let .benchDiscardMemberRecordings(repo, source, branches) = $0 { return repo == "/repo" && source == "josh" && branches == ["wt/a", "wt/b"] }; return false }),
            (.benchDiscardAllRecordings(repoPath: "/repo", sourceBranch: "josh"), { if case let .benchDiscardAllRecordings(repo, source) = $0 { return repo == "/repo" && source == "josh" }; return false }),
            (.worktreeRetire(repoPath: "/repo", worktreePath: "/wt", branchName: "wt/a"), { if case let .worktreeRetire(repo, path, branch) = $0 { return repo == "/repo" && path == "/wt" && branch == "wt/a" }; return false }),
            (.worktreeConflictAssist(repoPath: "/repo", worktreePath: "/wt"), { if case let .worktreeConflictAssist(repo, path) = $0 { return repo == "/repo" && path == "/wt" }; return false }),
            (.benchConflictAssist(repoPath: "/repo", sourceBranch: "josh"), { if case let .benchConflictAssist(repo, source) = $0 { return repo == "/repo" && source == "josh" }; return false }),
            (.worktreePipelineStart(repoPath: "/repo", sourceBranch: "josh"), { if case let .worktreePipelineStart(repo, source) = $0 { return repo == "/repo" && source == "josh" }; return false }),
            (.worktreePipelineConfirmAi(repoPath: "/repo"), { if case let .worktreePipelineConfirmAi(repo) = $0 { return repo == "/repo" }; return false }),
            (.worktreePipelineCancel(repoPath: "/repo"), { if case let .worktreePipelineCancel(repo) = $0 { return repo == "/repo" }; return false }),
            (.worktreePipelineDismiss(repoPath: "/repo"), { if case let .worktreePipelineDismiss(repo) = $0 { return repo == "/repo" }; return false }),
        ]

        for (command, matches) in cases {
            let data = try JSONEncoder().encode(command)
            let decoded = try JSONDecoder().decode(RemoteCommand.self, from: data)
            XCTAssertTrue(matches(decoded), "round trip changed \(command)")
        }
    }

    /// A shell in the bench and a conversation about it are separate commands,
    /// not one command with a flag: the desktop routes them to different store
    /// actions, and the terminal one keeps exactly one tab per bench.
    func testBenchTerminalCommandRoundTrips() throws {
        let cmd = RemoteCommand.benchOpenTerminal(repoPath: "/repo", sourceBranch: "feat/thing")

        let data = try JSONEncoder().encode(cmd)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["repoPath"] as? String, "/repo")
        XCTAssertEqual(json["sourceBranch"] as? String, "feat/thing")

        let decoded = try JSONDecoder().decode(RemoteCommand.self, from: data)
        guard case let .benchOpenTerminal(repo, source) = decoded else {
            return XCTFail("decoded to the wrong case: \(decoded)")
        }
        XCTAssertEqual(repo, "/repo")
        XCTAssertEqual(source, "feat/thing")
    }

    /// The new-conversation flag distinguishes two verbs on one command: tapping
    /// a row opens or cycles what exists, the row menu creates an additional one.
    func testOpenConversationCarriesTheNewConversationFlag() throws {
        for flag in [true, false] {
            let cmd = RemoteCommand.worktreeOpenConversation(worktreePath: "/wt/a", newConversation: flag)

            let json = try XCTUnwrap(
                JSONSerialization.jsonObject(with: try JSONEncoder().encode(cmd)) as? [String: Any])
            XCTAssertEqual(json["newConversation"] as? Bool, flag)

            let decoded = try JSONDecoder().decode(RemoteCommand.self, from: try JSONEncoder().encode(cmd))
            guard case let .worktreeOpenConversation(path, newConversation) = decoded else {
                return XCTFail("decoded to the wrong case: \(decoded)")
            }
            XCTAssertEqual(path, "/wt/a")
            XCTAssertEqual(newConversation, flag)
        }
    }

    /// An older desktop sends no flag. Absent must read as open-or-cycle, never
    /// as "create another" -- guessing wrong there stacks duplicate conversations.
    func testAbsentNewConversationFlagDecodesAsOpenOrCycle() throws {
        let json = #"{"type":"desktop_worktree_open_conversation","worktreePath":"/wt/a"}"#
            .data(using: .utf8)!

        let decoded = try JSONDecoder().decode(RemoteCommand.self, from: json)

        guard case let .worktreeOpenConversation(_, newConversation) = decoded else {
            return XCTFail("decoded to the wrong case: \(decoded)")
        }
        XCTAssertFalse(newConversation)
    }

    /// `landedAt` is the only honest signal for "finished". `safeToDiscard` is
    /// "nothing to lose", equally true of a worktree that never committed, so
    /// grouping on it files every fresh empty worktree as if work had shipped.
    func testLandedAtDrivesTheFinishedGrouping() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[{
          "worktreePath":"/wt/fresh","branchName":"wt/fresh","label":"fresh","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":true},{
          "worktreePath":"/wt/done","branchName":"wt/done","label":"done","sourceBranch":"josh",
          "head":"def","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":true,"landedAt":1700000000000}],"benches":[]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let byPath = { (p: String) in states[0].worktrees.first { $0.worktreePath == p }! }
        // Both are discardable; only one has actually landed.
        XCTAssertTrue(byPath("/wt/fresh").safeToDiscard)
        XCTAssertFalse(byPath("/wt/fresh").isLanded)
        XCTAssertTrue(byPath("/wt/done").isLanded)
    }

    /// `isLanded` is strictly `landedAt != nil`. A worktree with `landedAt` set
    /// is landed even if new commits appeared afterwards -- the desktop clears
    /// `landedAt` itself when the worktree resumes active work.
    func testLandedAtAloneDeterminesIsLanded() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[{
          "worktreePath":"/wt/a","branchName":"wt/a","label":"a","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":3,
          "needsSync":false,"safeToDiscard":false,"landedAt":1700000000000}],"benches":[]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertTrue(states[0].worktrees[0].isLanded)
    }



    /// A cleared stage must encode as an explicit null. `encodeIfPresent`
    /// would omit the key, and an absent key reads as "no change" on the
    /// desktop -- so clearing a stage would silently do nothing.
    func testClearedStageEncodesAsExplicitNull() throws {
        let cmd = RemoteCommand.worktreeSetStage(
            repoPath: "/repo", worktreePath: "/wt/a", stage: nil)

        let data = try JSONEncoder().encode(cmd)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertTrue(json.keys.contains("stage"))
        XCTAssertTrue(json["stage"] is NSNull)
    }

    func testStageAndReorderCommandsCarryEveryField() throws {
        let stage = RemoteCommand.worktreeSetStage(
            repoPath: "/repo", worktreePath: "/wt/a", stage: "bug")
        let stageJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try JSONEncoder().encode(stage)) as? [String: Any])
        XCTAssertEqual(stageJSON["repoPath"] as? String, "/repo")
        XCTAssertEqual(stageJSON["worktreePath"] as? String, "/wt/a")
        XCTAssertEqual(stageJSON["stage"] as? String, "bug")

        let reorder = RemoteCommand.benchReorderMember(
            repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt/a", toIndex: 2)
        let reorderJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try JSONEncoder().encode(reorder)) as? [String: Any])
        XCTAssertEqual(reorderJSON["toIndex"] as? Int, 2)
    }

    /// Only the read-only refresh dedupes. The mutating verbs are distinct
    /// operator actions and must never collapse into one another.
    func testOnlyRefreshHasAnEssentialKey() {
        XCTAssertEqual(
            RemoteCommand.worktreeRefresh(repoPath: "/repo").essentialKey,
            "worktreeRefresh:/repo")
        XCTAssertNil(RemoteCommand.benchAssemble(repoPath: "/repo", sourceBranch: "josh").essentialKey)
        XCTAssertNil(RemoteCommand.worktreeLandAndRetire(
            repoPath: "/repo", worktreePath: "/wt", worktreeBranch: "wt/a", sourceBranch: "josh").essentialKey)
    }
}
