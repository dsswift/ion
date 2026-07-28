import XCTest
@testable import IonRemote

/// Worktree + integration bench wire parity.
///
/// The desktop owns this wire (ADR-008) and it is lockstep: a rename ships to
/// both sides in one change. These tests pin the exact type strings and the
/// decode of every field the UI renders, so a desktop-side change that misses
/// Swift fails here rather than silently degrading at runtime.
final class WorktreeWireTests: XCTestCase {

    // MARK: - Commands (iOS → desktop)

    /// Every command's wire `type` string, asserted literally. A typo here is
    /// invisible until the desktop ignores the frame.
    func testCommandTypeStrings() throws {
        let cases: [(RemoteCommand, String)] = [
            (.worktreeRefresh(repoPath: "/repo"), "desktop_worktree_refresh"),
            (.worktreeOpenConversation(worktreePath: "/wt"), "desktop_worktree_open_conversation"),
            (.worktreeSync(worktreePath: "/wt", sourceBranch: "josh", repoPath: "/repo"), "desktop_worktree_sync"),
            (.worktreeLand(repoPath: "/repo", worktreePath: "/wt", worktreeBranch: "wt/a", sourceBranch: "josh"),
             "desktop_worktree_land"),
            (.benchOpenConversation(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_open_conversation"),
            (.benchRebuild(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_rebuild"),
            (.benchUpdateMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt"),
             "desktop_bench_update_member"),
            (.benchUpdateAll(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_update_all"),
            (.benchSetEnabled(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt", enabled: false),
             "desktop_bench_set_enabled"),
            (.benchAddMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt", branchName: "wt/a"),
             "desktop_bench_add_member"),
            (.benchRemoveMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt"),
             "desktop_bench_remove_member"),
        ]

        for (command, expected) in cases {
            let data = try JSONEncoder().encode(command)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(json["type"] as? String, expected, "wrong type string for \(command)")
        }
    }

    func testLandCommandCarriesEveryField() throws {
        let cmd = RemoteCommand.worktreeLand(
            repoPath: "/repo", worktreePath: "/wt/a", worktreeBranch: "wt/a3f1", sourceBranch: "josh")

        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try JSONEncoder().encode(cmd)) as? [String: Any])

        XCTAssertEqual(json["repoPath"] as? String, "/repo")
        XCTAssertEqual(json["worktreePath"] as? String, "/wt/a")
        XCTAssertEqual(json["worktreeBranch"] as? String, "wt/a3f1")
        XCTAssertEqual(json["sourceBranch"] as? String, "josh")
    }

    func testCommandsRoundTrip() throws {
        let cmd = RemoteCommand.benchSetEnabled(
            repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt/a", enabled: false)

        let decoded = try JSONDecoder().decode(RemoteCommand.self, from: try JSONEncoder().encode(cmd))

        guard case let .benchSetEnabled(repo, source, path, enabled) = decoded else {
            return XCTFail("decoded to the wrong case: \(decoded)")
        }
        XCTAssertEqual(repo, "/repo")
        XCTAssertEqual(source, "josh")
        XCTAssertEqual(path, "/wt/a")
        XCTAssertFalse(enabled)
    }

    /// Only the read-only refresh dedupes. The mutating verbs are distinct
    /// operator actions and must never collapse into one another.
    func testOnlyRefreshHasAnEssentialKey() {
        XCTAssertEqual(
            RemoteCommand.worktreeRefresh(repoPath: "/repo").essentialKey,
            "worktreeRefresh:/repo")
        XCTAssertNil(RemoteCommand.benchRebuild(repoPath: "/repo", sourceBranch: "josh").essentialKey)
        XCTAssertNil(RemoteCommand.worktreeLand(
            repoPath: "/repo", worktreePath: "/wt", worktreeBranch: "wt/a", sourceBranch: "josh").essentialKey)
    }

    // MARK: - Events (desktop → iOS)

    func testWorktreeStateDecodesEveryRenderedField() throws {
        let json = """
        {
          "type": "desktop_worktree_state",
          "states": [{
            "repoPath": "/repo",
            "worktrees": [{
              "worktreePath": "/wt/a",
              "branchName": "wt/a3f1",
              "label": "project-a3f1",
              "sourceBranch": "josh",
              "head": "abc1234",
              "lastCommitSubject": "fix token expiry",
              "isDirty": true,
              "unlandedCommitCount": 4,
              "needsSync": true,
              "safeToDiscard": false,
              "provisionState": "building",
              "openTabId": "tab-1"
            }],
            "benches": [{
              "repoPath": "/repo",
              "sourceBranch": "josh",
              "benchPath": "/bench",
              "benchBranch": "ion/bench/josh",
              "baseSha": "9c2b17e0000",
              "lastBuiltAt": 1700000000000,
              "baseDrifted": true,
              "members": [{
                "worktreePath": "/wt/a",
                "branchName": "wt/a3f1",
                "label": "project-a3f1",
                "enabled": true,
                "pinnedSha": "9c2b17e1111",
                "status": "stale",
                "conflictPaths": ["src/a.ts"],
                "conflictsWith": ["wt/7b0c"]
              }]
            }]
          }]
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else {
            return XCTFail("decoded to the wrong case: \(event)")
        }
        let state = try XCTUnwrap(states.first)
        let wt = try XCTUnwrap(state.worktrees.first)
        XCTAssertEqual(wt.label, "project-a3f1")
        XCTAssertEqual(wt.sourceBranch, "josh")
        XCTAssertEqual(wt.unlandedCommitCount, 4)
        XCTAssertTrue(wt.isDirty)
        XCTAssertTrue(wt.needsSync)
        XCTAssertFalse(wt.safeToDiscard)
        XCTAssertEqual(wt.provisionState, .building)
        XCTAssertEqual(wt.openTabId, "tab-1")

        let bench = try XCTUnwrap(state.benches.first)
        XCTAssertEqual(bench.benchBranch, "ion/bench/josh")
        XCTAssertTrue(bench.baseDrifted)
        XCTAssertTrue(bench.hasBeenBuilt)
        XCTAssertEqual(bench.staleMemberCount, 1)
        XCTAssertEqual(bench.enabledMemberCount, 1)

        let member = try XCTUnwrap(bench.members.first)
        XCTAssertEqual(member.status, .stale)
        XCTAssertEqual(member.pinnedSha, "9c2b17e1111")
        XCTAssertEqual(member.conflictPaths, ["src/a.ts"])
        XCTAssertEqual(member.conflictsWith, ["wt/7b0c"])
    }

    /// A worktree Ion did not create has no knowable source branch. It must
    /// decode as nil rather than failing, so the UI can disable land/sync
    /// instead of guessing a branch and landing work in the wrong place.
    func testNullSourceBranchDecodesAsNil() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","benches":[],"worktrees":[{
          "worktreePath":"/wt/x","branchName":"manual","label":"manual","sourceBranch":null,
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":false}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertNil(states[0].worktrees[0].sourceBranch)
    }

    /// A worktree created before provisioning existed carries no `provisionState`
    /// at all. Absent must decode as nil — "Ion has no record" — and the row
    /// renders nothing. Treating absence as a failure would put an error badge on
    /// every pre-existing worktree.
    func testAbsentProvisionStateDecodesAsNil() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","benches":[],"worktrees":[{
          "worktreePath":"/wt/x","branchName":"wt/x","label":"x","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":false}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertNil(states[0].worktrees[0].provisionState)
    }

    /// An unrecognised provisioning state from a newer desktop must not fail the
    /// whole worktree decode — one new enum case would otherwise blank the entire
    /// worktree list on an older build.
    func testUnknownProvisionStateDegradesRatherThanFailing() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","benches":[],"worktrees":[{
          "worktreePath":"/wt/x","branchName":"wt/x","label":"x","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":false,"provisionState":"quantum-tunnelling"}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        // Degrades to a benign state; the worktree itself still decoded.
        XCTAssertEqual(states[0].worktrees[0].provisionState, .idle)
        XCTAssertEqual(states[0].worktrees[0].label, "x")
    }

    /// `pending` decodes to its own case rather than degrading. A member enrolled
    /// before its first commit is a normal state, and showing it as `stale` would
    /// offer an Update that has nothing to advance to.
    func testPendingMemberStatusDecodes() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"josh","benchPath":"/b","benchBranch":"ion/bench/josh",
          "baseSha":"a","lastBuiltAt":1,"baseDrifted":false,"members":[{
            "worktreePath":"/wt/a","branchName":"wt/a","label":"a","enabled":true,
            "pinnedSha":"abc","status":"pending"}]}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(states[0].benches[0].members[0].status, .pending)
    }

    /// An unknown status from a newer desktop must not fail the whole payload:
    /// the operator would lose the entire bench view over one field.
    func testUnknownMemberStatusDegradesRatherThanFailing() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"josh","benchPath":"/b","benchBranch":"ion/bench/josh",
          "baseSha":"a","lastBuiltAt":1,"baseDrifted":false,"members":[{
            "worktreePath":"/wt/a","branchName":"wt/a","label":"a","enabled":true,
            "pinnedSha":"abc","status":"some_future_status"}]}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(states[0].benches[0].members[0].status, .stale)
    }

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
            ok: false, operation: .land, error: "conflict", refusedDirty: nil, hasConflicts: true))

        let decoded = try JSONDecoder().decode(
            RemoteEvent.self, from: try JSONEncoder().encode(original))

        guard case let .worktreeOpResult(result) = decoded else { return XCTFail("wrong case") }
        XCTAssertEqual(result.operation, .land)
        XCTAssertEqual(result.hasConflicts, true)
        XCTAssertEqual(result.error, "conflict")
    }
}
