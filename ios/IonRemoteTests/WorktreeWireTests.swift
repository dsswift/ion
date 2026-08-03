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
            (.worktreeOpenConversation(worktreePath: "/wt", newConversation: false),
             "desktop_worktree_open_conversation"),
            (.worktreeSync(worktreePath: "/wt", sourceBranch: "josh", repoPath: "/repo"), "desktop_worktree_sync"),
            (.worktreeLand(repoPath: "/repo", worktreePath: "/wt", worktreeBranch: "wt/a", sourceBranch: "josh"),
             "desktop_worktree_land"),
            (.benchOpenConversation(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_open_conversation"),
            (.benchOpenTerminal(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_open_terminal"),
            (.benchAssemble(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_assemble"),
            (.benchUpdateMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt"),
             "desktop_bench_update_member"),
            (.benchUpdateAll(repoPath: "/repo", sourceBranch: "josh"), "desktop_bench_update_all"),
            (.benchSetEnabled(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt", enabled: false),
             "desktop_bench_set_enabled"),
            (.benchSetReview(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt", review: "good"),
             "desktop_bench_set_review"),
            (.benchReorderMember(repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt", toIndex: 0),
             "desktop_bench_reorder_member"),
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

    /// A worktree that landed and then kept committing is active again.
    func testCommittingAfterLandingLeavesTheFinishedGroup() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[{
          "worktreePath":"/wt/a","branchName":"wt/a","label":"a","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":3,
          "needsSync":false,"safeToDiscard":false,"landedAt":1700000000000}],"benches":[]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertFalse(states[0].worktrees[0].isLanded)
    }

    /// A cleared verdict must encode as an explicit null. `encodeIfPresent`
    /// would omit the key, and an absent key reads as "no change" on the
    /// desktop -- so clearing a verdict would silently do nothing.
    func testClearedReviewEncodesAsExplicitNull() throws {
        let cmd = RemoteCommand.benchSetReview(
            repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt/a", review: nil)

        let data = try JSONEncoder().encode(cmd)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertTrue(json.keys.contains("review"))
        XCTAssertTrue(json["review"] is NSNull)
    }

    func testReviewAndReorderCommandsCarryEveryField() throws {
        let review = RemoteCommand.benchSetReview(
            repoPath: "/repo", sourceBranch: "josh", worktreePath: "/wt/a", review: "issue")
        let reviewJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try JSONEncoder().encode(review)) as? [String: Any])
        XCTAssertEqual(reviewJSON["worktreePath"] as? String, "/wt/a")
        XCTAssertEqual(reviewJSON["review"] as? String, "issue")

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
              ],
              "membership": {
                "sourceBranch": "josh", "enabled": true,
                "pin": "behind", "merge": "conflicted", "review": "issue",
                "pinnedSha": "9c2b17e1111", "order": 1,
                "conflictPaths": ["src/a.ts"], "conflictsWith": ["wt/7b0c"],
                "mergeResolution": "replayed"
              }
            }],
            "benches": [{
              "repoPath": "/repo",
              "sourceBranch": "josh",
              "benchPath": "/bench",
              "benchBranch": "ion/bench/josh",
              "baseSha": "9c2b17e0000",
              "lastBuiltAt": 1700000000000,
              "lastAssembly": "failed",
              "lastAssemblyError": "wt/a3f1 conflicts on 1 file. The bench is empty until this is resolved.",
              "baseDrifted": true,
              "orphans": [],
              "openConversations": [
                {"tabId": "tab-9", "title": "Bench build", "status": "idle", "index": 9}
              ],
              "benchConversationTabId": "tab-talk",
              "benchTerminalTabId": "tab-term"
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
        // Atomic assembly: `failed` means the bench is EMPTY, and the header
        // and footer both read these instead of implying a usable build.
        XCTAssertEqual(bench.lastAssembly, "failed")
        XCTAssertEqual(bench.lastAssemblyError,
                       "wt/a3f1 conflicts on 1 file. The bench is empty until this is resolved.")
        XCTAssertEqual(bench.openConversations.map(\.tabId), ["tab-9"])
        XCTAssertEqual(bench.benchConversationTabId, "tab-talk")
        XCTAssertTrue(bench.orphans.isEmpty)
        // The bench's dedicated terminal, which is what lets the row say
        // "Go to terminal" rather than offering to open a second one.
        XCTAssertEqual(bench.benchTerminalTabId, "tab-term")

        // Membership rides the WORKTREE. It used to arrive as a separate
        // RemoteBenchMember carrying its own copy of the path, branch and label,
        // so an enrolled worktree crossed the wire twice in two shapes.
        let m = try XCTUnwrap(wt.membership)
        XCTAssertEqual(m.sourceBranch, "josh")
        XCTAssertEqual(m.pinnedSha, "9c2b17e1111")
        XCTAssertEqual(m.order, 1)
        XCTAssertEqual(m.conflictPaths, ["src/a.ts"])
        XCTAssertEqual(m.conflictsWith, ["wt/7b0c"])
        // A replayed rerere resolution is a different fact from a clean merge.
        XCTAssertEqual(m.mergeResolution, "replayed")
        // Three axes, all readable at once. The single `status` they replaced
        // could report only one of these three.
        XCTAssertTrue(m.enabled)
        XCTAssertEqual(m.pin, .behind)
        XCTAssertEqual(m.merge, .conflicted)
        XCTAssertEqual(m.review, .issue)
        // The bench derives its counts from the worktrees now: one object,
        // counted once.
        XCTAssertEqual(state.behindMemberCount(of: bench), 1)
        XCTAssertEqual(state.conflictedMemberCount(of: bench), 1)
        XCTAssertEqual(state.enabledMemberCount(of: bench), 1)
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
          "benchBranch":"ion/bench/josh","baseSha":"aaa","lastBuiltAt":0,"baseDrifted":false}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let wt = states[0].worktrees[0]
        XCTAssertNil(wt.title)
        XCTAssertEqual(wt.openConversations, [])
        // With no title the slug is what the row shows -- never a placeholder.
        XCTAssertEqual(wt.displayName, "x")

        // Unenrolled: membership ABSENT is a different fact from enabled:false
        // (enrolled and skipped), so it decodes to nil rather than a default.
        XCTAssertNil(wt.membership)
        XCTAssertEqual(wt.enrollment, .none)

        let bench = states[0].benches[0]
        XCTAssertEqual(bench.openConversations, [])
        // An older desktop sends no `orphans`; an empty list is the right
        // reading, never a decode failure that would blank the bench view.
        XCTAssertEqual(bench.orphans, [])
        XCTAssertNil(bench.benchConversationTabId)
        // Likewise no `benchTerminalTabId`. Absent means "no terminal open",
        // which the row renders as "Open terminal" -- never as an error.
        XCTAssertNil(bench.benchTerminalTabId)
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

    /// `empty` decodes to its own case rather than degrading. A member enrolled
    /// before its first commit is a normal state, and showing it as `behind`
    /// would offer an Update that has nothing to advance to.
    func testEmptyPinDecodes() throws {
        let json = membershipJSON(pin: "empty", merge: "skipped")

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertEqual(states[0].worktrees[0].membership?.pin, .empty)
    }

    /// An excluded member that is ALSO behind reports both. Under the single
    /// collapsed status this was impossible: the record held one word, so the
    /// operator re-enabled it and got a stale merge with no warning.
    func testExcludedAndBehindAreBothReadable() throws {
        let json = membershipJSON(pin: "behind", merge: "skipped", enabled: false)

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let m = try XCTUnwrap(states[0].worktrees[0].membership)
        XCTAssertFalse(m.enabled)
        XCTAssertEqual(m.pin, .behind)
        XCTAssertEqual(states[0].worktrees[0].enrollment, .excluded)
    }

    /// An unknown axis value from a newer desktop must not fail the whole
    /// payload: the operator would lose the entire worktree list over one field.
    /// It degrades to the CONSERVATIVE reading, which cannot be mistaken for a
    /// successful integration.
    func testUnknownAxisValuesDegradeRatherThanFailing() throws {
        let json = membershipJSON(pin: "some_future_pin", merge: "some_future_merge")

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let m = try XCTUnwrap(states[0].worktrees[0].membership)
        XCTAssertEqual(m.pin, .current)
        XCTAssertEqual(m.merge, .unbuilt)
    }

    /// An unknown REVIEW value degrades to nil -- unreviewed -- rather than
    /// inventing a verdict the operator never gave.
    func testUnknownReviewDegradesToUnreviewed() throws {
        let json = membershipJSON(pin: "current", merge: "merged", review: "\"maybe\"")

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertNil(states[0].worktrees[0].membership?.review)
    }

    /// One worktree carrying a membership, for the axis tests above.
    private func membershipJSON(
        pin: String, merge: String, enabled: Bool = true, review: String = "null"
    ) -> Data {
        """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[{
          "worktreePath":"/wt/a","branchName":"wt/a","label":"a","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":false,
          "membership":{"sourceBranch":"josh","enabled":\(enabled),"pin":"\(pin)",
            "merge":"\(merge)","review":\(review),"pinnedSha":"abc","order":1}}],
          "benches":[]}]}
        """.data(using: .utf8)!
    }
}
