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
              "title": "Fix the token expiry check",
              "openConversations": [
                {"tabId": "tab-1", "title": "Fix the parser", "status": "running", "index": 2},
                {"tabId": "tab-2", "title": "Add tests", "status": "idle", "index": 4}
              ]
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
                "title": "Rework the relay auth",
                "conflictPaths": ["src/a.ts"],
                "conflictsWith": ["wt/7b0c"],
                "openConversations": [
                  {"tabId": "tab-3", "title": "Relay auth work", "status": "idle", "index": 5}
                ]
              }],
              "openConversations": [
                {"tabId": "tab-9", "title": "Bench build", "status": "idle", "index": 9}
              ]
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
        // The human title, and the display rule that prefers it over the slug.
        XCTAssertEqual(wt.title, "Fix the token expiry check")
        XCTAssertEqual(wt.displayName, "Fix the token expiry check")
        // Every conversation, named and indexed -- not a single opaque tab id.
        XCTAssertEqual(wt.openConversations.count, 2)
        XCTAssertEqual(wt.openConversations[0].tabId, "tab-1")
        XCTAssertEqual(wt.openConversations[0].title, "Fix the parser")
        XCTAssertEqual(wt.openConversations[0].status, "running")
        XCTAssertEqual(wt.openConversations[0].index, 2)
        XCTAssertEqual(wt.openConversations[1].title, "Add tests")

        let bench = try XCTUnwrap(state.benches.first)
        XCTAssertEqual(bench.benchBranch, "ion/bench/josh")
        XCTAssertTrue(bench.baseDrifted)
        XCTAssertTrue(bench.hasBeenBuilt)
        XCTAssertEqual(bench.staleMemberCount, 1)
        XCTAssertEqual(bench.enabledMemberCount, 1)
        XCTAssertEqual(bench.openConversations.map(\.tabId), ["tab-9"])

        let member = try XCTUnwrap(bench.members.first)
        XCTAssertEqual(member.status, .stale)
        XCTAssertEqual(member.pinnedSha, "9c2b17e1111")
        XCTAssertEqual(member.conflictPaths, ["src/a.ts"])
        XCTAssertEqual(member.conflictsWith, ["wt/7b0c"])
        // The member title is resolved by the desktop from the worktree
        // inventory, never stored twice -- iOS just renders what arrives.
        XCTAssertEqual(member.title, "Rework the relay auth")
        XCTAssertEqual(member.displayName, "Rework the relay auth")
        // A member's conversations live in the MEMBER's worktree, not the bench.
        XCTAssertEqual(member.openConversations.map(\.tabId), ["tab-3"])
    }

    /// A desktop that has not shipped the naming change yet sends neither
    /// `title` nor `openConversations`. Both must decode to their empty forms
    /// rather than failing: one missing field would otherwise blank the entire
    /// worktree list on a mismatched pair.
    func testAbsentTitleAndConversationsDecodeToEmptyForms() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[{
          "worktreePath":"/wt/x","branchName":"wt/x","label":"x","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":false}],"benches":[{
          "repoPath":"/repo","sourceBranch":"josh","benchPath":"/bench",
          "benchBranch":"ion/bench/josh","baseSha":"aaa","lastBuiltAt":0,"baseDrifted":false,
          "members":[{"worktreePath":"/wt/y","branchName":"wt/y","label":"y","enabled":true,
          "pinnedSha":"bbb","status":"integrated"}]}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let wt = states[0].worktrees[0]
        XCTAssertNil(wt.title)
        XCTAssertEqual(wt.openConversations, [])
        // With no title the slug is what the row shows -- never a placeholder.
        XCTAssertEqual(wt.displayName, "x")

        let bench = states[0].benches[0]
        XCTAssertEqual(bench.openConversations, [])
        XCTAssertNil(bench.members[0].title)
        XCTAssertEqual(bench.members[0].openConversations, [])
        XCTAssertEqual(bench.members[0].displayName, "y")
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

    /// A mid-operation worktree (the state a conflicted sync leaves behind)
    /// decodes with its operation and conflict count. This worktree used to
    /// vanish from the desktop panel entirely; on iOS the same state must at
    /// minimum render, not disappear or look healthy.
    func testMidOperationWorktreeDecodes() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","benches":[],"worktrees":[{
          "worktreePath":"/wt/a","branchName":"wt/a","label":"a","sourceBranch":"josh",
          "head":"abc1234","lastCommitSubject":"edit shared","isDirty":false,
          "unlandedCommitCount":0,"needsSync":false,"safeToDiscard":false,
          "operationState":"rebasing","conflictedCount":2}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let wt = states[0].worktrees[0]
        XCTAssertEqual(wt.operationState, .rebasing)
        XCTAssertEqual(wt.conflictedCount, 2)
    }

    /// An unknown operationState from a newer desktop degrades to `.rebasing`
    /// (generic "operation in progress") rather than failing the payload.
    func testUnknownOperationStateDegradesRatherThanFailing() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","benches":[],"worktrees":[{
          "worktreePath":"/wt/a","branchName":"wt/a","label":"a","sourceBranch":"josh",
          "head":"abc1234","lastCommitSubject":"x","isDirty":false,
          "unlandedCommitCount":0,"needsSync":false,"safeToDiscard":false,
          "operationState":"some_future_operation"}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(states[0].worktrees[0].operationState, .rebasing)
        XCTAssertNil(states[0].worktrees[0].conflictedCount)
    }

    /// A quiescent worktree carries neither field.
    func testQuiescentWorktreeHasNoOperationState() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","benches":[],"worktrees":[{
          "worktreePath":"/wt/a","branchName":"wt/a","label":"a","sourceBranch":"josh",
          "head":"abc1234","lastCommitSubject":"x","isDirty":false,
          "unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertNil(states[0].worktrees[0].operationState)
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
