import XCTest
@testable import IonRemote

/// Worktree + integration bench wire parity — EVENTS (desktop → iOS).
///
/// Split from the original WorktreeWireTests.swift (file-size cap): the
/// command half now lives in WorktreeWireCommandTests.swift. This half pins
/// the decode of every state field the UI renders. The desktop owns this wire
/// (ADR-008) and it is lockstep: a rename ships to both sides in one change.
final class WorktreeWireTests: XCTestCase {

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
              "stage": "bug",
              "openConversations": [
                {"tabId": "tab-1", "title": "Fix the parser", "status": "running", "index": 2},
                {"tabId": "tab-2", "title": "Add tests", "status": "idle", "index": 4}
              ],
              "membership": {
                "sourceBranch": "josh",
                "pin": "behind", "merge": "conflicted",
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
                {"tabId": "tab-9", "title": "Bench build", "status": "idle", "index": 9},
                {"tabId": "tab-fix", "title": "Resolve merge", "status": "running", "index": 10, "tabRole": "conflict-auto-fix"},
                {"tabId": "tab-analysis", "title": "Inspect verification", "status": "idle", "index": 11, "tabRole": "verification-analysis"}
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
        XCTAssertEqual(bench.openConversations.map(\.tabId), ["tab-9", "tab-fix", "tab-analysis"])
        XCTAssertEqual(bench.openConversations[1].roleLabel, "Auto-fix")
        XCTAssertEqual(bench.openConversations[2].roleLabel, "Analysis")
        XCTAssertEqual(bench.activeAutoFixTabId, "tab-fix")
        XCTAssertEqual(bench.conversationActionTitle, "Go to · Analysis + Auto-fix")
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
        // Pin freshness and merge outcome are both readable. The single
        // `status` they replaced could report only one of these facts.
        XCTAssertEqual(m.pin, .behind)
        XCTAssertEqual(m.merge, .conflicted)
        // The workflow stage rides the WORKTREE, not the membership: it is
        // registry-scoped on the desktop and exists for unenrolled rows too.
        XCTAssertEqual(wt.stage, .bug)
        // The bench derives its counts from the worktrees now: one object,
        // counted once.
        XCTAssertEqual(state.behindMemberCount(of: bench), 1)
        XCTAssertEqual(state.conflictedMemberCount(of: bench), 1)
        XCTAssertEqual(state.memberCount(of: bench), 1)
    }

    func testRunningBenchAutoFixIsIdentifiedForFocusAndAttention() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"main","benchPath":"/bench",
          "benchBranch":"ion/bench/main","baseSha":"aaa","lastBuiltAt":0,"baseDrifted":false,
          "openConversations":[
            {"tabId":"talk","title":"Talk","status":"idle","index":1,"tabRole":"bench-conversation"},
            {"tabId":"fix","title":"Resolve","status":"running","index":2,"tabRole":"conflict-auto-fix"},
            {"tabId":"analysis","title":"Analysis","status":"idle","index":3,"tabRole":"verification-analysis"}
          ]
        }]}]}
        """.data(using: .utf8)!

        guard case let .worktreeState(states) = try JSONDecoder().decode(RemoteEvent.self, from: json) else {
            return XCTFail("wrong case")
        }
        XCTAssertEqual(states[0].benches[0].activeAutoFixTabId, "fix")
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

        // A missing membership means this worktree is not in a bench.
        XCTAssertNil(wt.membership)
        XCTAssertFalse(wt.isBenchMember)

        let bench = states[0].benches[0]
        XCTAssertEqual(bench.openConversations, [])
        // An older desktop sends no `orphans`; an empty list is the right
        // reading, never a decode failure that would blank the bench view.
        XCTAssertEqual(bench.orphans, [])
        XCTAssertNil(bench.benchConversationTabId)
        XCTAssertNil(bench.openConversations.first?.tabRole)
        // Likewise no `benchTerminalTabId`. Absent means "no terminal open",
        // which the row renders as "Open terminal" -- never as an error.
        XCTAssertNil(bench.benchTerminalTabId)
        // Likewise the verification-failure split: an older desktop sends
        // neither key, which must decode to nil/unclassified rather than a
        // decode failure or a defaulted `"conflict"`.
        XCTAssertNil(bench.lastAssemblyFailure)
        XCTAssertNil(bench.lastAssemblyVerification)
    }

    /// A bench whose last assembly failed VERIFICATION (not a merge conflict):
    /// every merge succeeded, including a replayed rerere resolution, but the
    /// project's own verify command rejected the resulting tree.
    func testVerificationFailureBenchDecodes() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"josh","benchPath":"/bench",
          "benchBranch":"ion/bench/josh","baseSha":"aaa","lastBuiltAt":1700000000000,
          "lastAssembly":"failed",
          "lastAssemblyError":"A recorded conflict resolution failed project verification.",
          "lastAssemblyFailure":"verification",
          "lastAssemblyVerification":{
            "command":"cd engine && go build ./... && cd ../desktop && npm run typecheck",
            "outputTail":"src/renderer/components/WorktreeRowMenu.tsx(122,8): error TS1109",
            "replayedBranches":["wt/a","wt/c"]
          },
          "baseDrifted":false}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let bench = states[0].benches[0]
        XCTAssertEqual(bench.lastAssembly, "failed")
        XCTAssertEqual(bench.lastAssemblyFailure, "verification")
        let evidence = try XCTUnwrap(bench.lastAssemblyVerification)
        XCTAssertEqual(evidence.command, "cd engine && go build ./... && cd ../desktop && npm run typecheck")
        XCTAssertEqual(evidence.outputTail, "src/renderer/components/WorktreeRowMenu.tsx(122,8): error TS1109")
        XCTAssertEqual(evidence.replayedBranches, ["wt/a", "wt/c"])
    }

    /// A plain merge-conflict failure classifies distinctly and carries no
    /// verification evidence -- the two failure kinds must never be conflated.
    func testConflictFailureClassifiesDistinctlyFromVerification() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"josh","benchPath":"/bench",
          "benchBranch":"ion/bench/josh","baseSha":"aaa","lastBuiltAt":1700000000000,
          "lastAssembly":"failed",
          "lastAssemblyError":"wt/a conflicts on 1 file. The bench is empty until this is resolved.",
          "lastAssemblyFailure":"conflict",
          "baseDrifted":false}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let bench = states[0].benches[0]
        XCTAssertEqual(bench.lastAssemblyFailure, "conflict")
        XCTAssertNil(bench.lastAssemblyVerification)
    }

    /// A merge failure that never reached conflict state (e.g. an untracked
    /// file blocking git's own write) classifies as `obstructed` -- distinct
    /// from both a content conflict and a verification failure, and likewise
    /// carries no verification evidence. `lastAssemblyFailure` decodes as a
    /// bare string (no fixed Swift enum), so a new wire value like this one
    /// requires no iOS decode change -- confirmed by this test passing without
    /// any model change alongside it.
    func testObstructedFailureClassifiesDistinctlyAndSurfacesTheRealGitError() throws {
        let json = """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[],"benches":[{
          "repoPath":"/repo","sourceBranch":"josh","benchPath":"/bench",
          "benchBranch":"ion/bench/josh","baseSha":"aaa","lastBuiltAt":1700000000000,
          "lastAssembly":"failed",
          "lastAssemblyError":"wt/a3f1 could not be merged: error: The following untracked working tree files would be overwritten by merge:\\n\\tdesktop/src/main/worktree/sync.ts",
          "lastAssemblyFailure":"obstructed",
          "baseDrifted":false}]}]}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let bench = states[0].benches[0]
        XCTAssertEqual(bench.lastAssemblyFailure, "obstructed")
        XCTAssertNil(bench.lastAssemblyVerification)
        // The real git error, not the old bare "could not be merged" fallback.
        XCTAssertTrue(bench.lastAssemblyError?.contains("would be overwritten by merge") == true)
        XCTAssertTrue(bench.lastAssemblyError?.contains("desktop/src/main/worktree/sync.ts") == true)
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

    /// Every membership is included in its bench. A skipped merge outcome stays
    /// valid because it records what a past assembly did, not current enrollment.
    func testMemberWithSkippedMergeOutcomeDecodes() throws {
        let json = membershipJSON(pin: "behind", merge: "skipped")

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        let worktree = states[0].worktrees[0]
        XCTAssertTrue(worktree.isBenchMember)
        XCTAssertEqual(worktree.membership?.pin, .behind)
        XCTAssertEqual(worktree.membership?.merge, .skipped)
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

    /// An unknown STAGE value degrades to nil -- no marker -- rather than
    /// inventing a stage the operator never set. Guards a future desktop
    /// shipping a stage this build does not know.
    func testUnknownStageDegradesToNoStage() throws {
        let json = membershipJSON(pin: "current", merge: "merged", stage: "\"shipping-it\"")

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
        XCTAssertNil(states[0].worktrees[0].stage)
    }

    /// Every stage the desktop can send decodes to its Swift case, pinning the
    /// raw-value parity of the curated vocabulary.
    func testEveryKnownStageDecodes() throws {
        for stage in WorkStage.allCases {
            let json = membershipJSON(pin: "current", merge: "merged", stage: "\"\(stage.rawValue)\"")
            let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
            guard case let .worktreeState(states) = event else { return XCTFail("wrong case") }
            XCTAssertEqual(states[0].worktrees[0].stage, stage)
        }
    }

    /// One worktree carrying a membership, for the axis tests above.
    private func membershipJSON(
        pin: String, merge: String, stage: String = "null"
    ) -> Data {
        """
        {"type":"desktop_worktree_state","states":[{"repoPath":"/repo","worktrees":[{
          "worktreePath":"/wt/a","branchName":"wt/a","label":"a","sourceBranch":"josh",
          "head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
          "needsSync":false,"safeToDiscard":false,"stage":\(stage),
          "membership":{"sourceBranch":"josh","pin":"\(pin)",
            "merge":"\(merge)","pinnedSha":"abc","order":1}}],
          "benches":[]}]}
        """.data(using: .utf8)!
    }
}
