import XCTest
@testable import IonRemote

/// What an action's value becomes: the events the view model used to receive
/// as named reply frames on the `desktop_*` wire.
final class StudioCommandResultTests: XCTestCase {

    private let mapping = StudioTransportCommandMapping(benchPath: { _, _ in "/repo/.ion/bench" })

    private func events(_ command: RemoteCommand, _ action: String, _ result: JSONValue) -> [RemoteEvent] {
        mapping.events(for: command, call: .positional(action), result: result)
    }

    // MARK: - Conversations

    func testAnAcceptedPromptAnswersTheClientsOwnMessageId() {
        let command = RemoteCommand.prompt(tabId: "t1", text: "hi", clientMsgId: "m-9")
        let events = events(command, "session.prompt", .object(["accepted": .bool(true), "clientMsgId": .string("m-9")]))
        guard case .promptResult(let tabId, let clientMsgId, let status, let error) = events.first else {
            return XCTFail("expected a prompt result, got \(events)")
        }
        XCTAssertEqual([tabId, clientMsgId, status], ["t1", "m-9", "accepted"])
        XCTAssertNil(error)
    }

    func testARejectedPromptCarriesTheReasonSoTheComposerKeepsItsText() {
        let command = RemoteCommand.prompt(tabId: "t1", text: "hi", clientMsgId: "m-9")
        let events = events(command, "session.prompt", .object([
            "accepted": .bool(false), "clientMsgId": .string("m-9"), "reason": .string("this conversation is locked"),
        ]))
        guard case .promptResult(_, _, let status, let error) = events.first else {
            return XCTFail("expected a prompt result, got \(events)")
        }
        XCTAssertEqual(status, "rejected")
        XCTAssertEqual(error, "this conversation is locked")
    }

    func testAPromptThatNeverReachedTheServerIsARejection() {
        let command = RemoteCommand.prompt(tabId: "t1", text: "hi", clientMsgId: "m-9")
        let events = mapping.events(
            for: command, call: .positional("session.prompt"),
            failure: .refused(code: "scope", message: "not allowed"))
        guard case .promptResult(_, let clientMsgId, let status, let error) = events.first else {
            return XCTFail("expected a prompt result, got \(events)")
        }
        XCTAssertEqual([clientMsgId, status, error ?? ""], ["m-9", "rejected", "not allowed"])
    }

    func testAConversationClosesOnlyWhenTheServerSaysItDid() {
        let command = RemoteCommand.closeTab(tabId: "t1")
        XCTAssertEqual(events(command, "tabs.close", .object(["closed": .bool(false), "agentCount": .int(2)])).count, 0)
        guard case .tabClosed(let tabId) = events(command, "tabs.close", .object(["closed": .bool(true)])).first else {
            return XCTFail("expected the conversation to close")
        }
        XCTAssertEqual(tabId, "t1")
    }

    func testARefusedRewindReportsItselfAndAnAcceptedOneRestoresTheTurn() {
        let command = RemoteCommand.engineRewind(tabId: "t1", instanceId: "i1", messageId: "m1", userTurnIndex: 3)
        guard case .engineRewindResult(_, _, let error) = events(command, "engine.rewind", .object([
            "ok": .bool(false), "error": .string("no such message"),
        ])).first else { return XCTFail("expected a rewind result") }
        XCTAssertEqual(error, "no such message")

        guard case .inputPrefill(let tabId, let text, let switchTo, let instanceId) = events(command, "engine.rewind", .object([
            "ok": .bool(true), "pendingInput": .string("the rewound turn"),
        ])).first else { return XCTFail("expected the turn back in the composer") }
        XCTAssertEqual([tabId, text, instanceId ?? ""], ["t1", "the rewound turn", "i1"])
        XCTAssertFalse(switchTo)
    }

    func testBranchesAnswerTheListingAndARefusedSwitchSaysWhy() {
        guard case .conversationBranches(let tabId, let listing) = events(.listBranches(tabId: "t1"), "engine.listBranches", .object([
            "activeLeafId": .string("b"),
            "branchPoints": .array([]),
            "branches": .array([
                .object(["leafId": .string("a"), "timestamp": .int(1), "preview": .string("reply A"), "messageCount": .int(4), "forkPointId": .string("f"), "active": .bool(false)]),
                .object(["leafId": .string("b"), "timestamp": .int(2), "preview": .string("reply B"), "messageCount": .int(4), "active": .bool(true)]),
            ]),
        ])).first else { return XCTFail("expected the branches") }
        XCTAssertEqual(tabId, "t1")
        XCTAssertEqual(listing.branches.map(\.leafId), ["a", "b"])
        XCTAssertEqual(listing.branches.map(\.active), [false, true])

        let command = RemoteCommand.switchBranch(tabId: "t1", leafId: "a")
        guard case .branchSwitchResult(_, let accepted) = events(command, "engine.switchBranch", .null).first
        else { return XCTFail("expected a switch result") }
        XCTAssertNil(accepted)
        let refused = mapping.events(for: command, call: .positional("engine.switchBranch"),
                                     failure: .refused(code: "action_failed", message: "a run is active"))
        guard case .branchSwitchResult(_, let error) = refused.first else { return XCTFail("expected a refusal") }
        XCTAssertNotNil(error)
    }

    // MARK: - Git

    func testAStagedFileAnswersTheOutcomeAndThenTheRefreshedChanges() {
        let command = RemoteCommand.gitStage(directory: "/repo", paths: ["a.txt"])
        guard case .gitStageResult(let result) = events(command, "git.stage", .object(["ok": .bool(true)])).first else {
            return XCTFail("expected a stage result")
        }
        XCTAssertEqual(result.directory, "/repo")
        XCTAssertTrue(result.ok)

        // The refresh the older wire pushed is a read this client makes itself,
        // and it runs after the write rather than beside it.
        let next = mapping.next(for: command, after: .positional("git.stage"), result: .object(["ok": .bool(true)]))
        XCTAssertEqual(next?.action, "git.changes")
        XCTAssertEqual(next?.args, [.object(["directory": .string("/repo")])])
        XCTAssertNil(mapping.next(for: command, after: .positional("git.changes"), result: .null))
    }

    func testACommitRefreshesTheChangesAndThenTheGraph() {
        let command = RemoteCommand.gitCommit(directory: "/repo", message: "m")
        XCTAssertEqual(mapping.next(for: command, after: .positional("git.commit"), result: .null)?.action, "git.changes")
        XCTAssertEqual(mapping.next(for: command, after: .positional("git.changes"), result: .null)?.action, "git.graph")
        XCTAssertNil(mapping.next(for: command, after: .positional("git.graph"), result: .null))
    }

    func testAFailedPushReadsAsARefusalRatherThanSilence() {
        let events = mapping.events(
            for: .gitPush(directory: "/repo"), call: .positional("git.push"),
            failure: .failed(code: "action_failed", message: "remote rejected"))
        guard case .gitCommitResult(let result) = events.first else { return XCTFail("expected a mutation result") }
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "remote rejected")
    }

    // MARK: - Files
    // The server's `fs.*` values carry the outcome only, never the path asked for.

    func testADirectoryListingKeysOnTheDirectoryTheCommandAskedFor() {
        let command = RemoteCommand.fsListDir(directory: "/repo", includeHidden: false)
        guard case .fsDirListing(let directory, let response) = events(command, "fs.readDir", .object([
            "entries": .array([.object([
                "name": .string("a.txt"), "path": .string("/repo/a.txt"), "isDirectory": .bool(false),
                "size": .int(12), "modifiedMs": .double(1_700_000_000_000.5), "isHidden": .bool(false),
            ])]),
        ])).first else { return XCTFail("expected a directory listing") }
        XCTAssertEqual([directory, response.directory], ["/repo", "/repo"])
        XCTAssertEqual(response.entries.map(\.name), ["a.txt"])
        XCTAssertNil(response.error)
    }

    func testAnUnreadableListingShowsAnErrorRatherThanLoadingForever() {
        let command = RemoteCommand.fsListDir(directory: "/repo", includeHidden: false)
        guard case .fsDirListing(_, let response) = events(command, "fs.readDir", .object([
            "entries": .string("not a list"),
        ])).first else { return XCTFail("expected a directory listing") }
        XCTAssertNotNil(response.error)
    }

    func testAFailedListingShowsTheReasonRatherThanLoadingForever() {
        let events = mapping.events(
            for: .fsListDir(directory: "/repo", includeHidden: false), call: .positional("fs.readDir"),
            failure: .refused(code: "scope", message: "not allowed"))
        guard case .fsDirListing(let directory, let response) = events.first else {
            return XCTFail("expected a directory listing")
        }
        XCTAssertEqual(directory, "/repo")
        XCTAssertEqual(response.error, "not allowed")
    }

    func testFileReadWriteAndRenameKeyOnTheCommandsPaths() {
        guard case .fsFileContent(let readPath, let content) = events(
            .fsReadFile(filePath: "/repo/a.txt"), "fs.readFile", .object(["content": .string("hi")])
        ).first else { return XCTFail("expected file content") }
        XCTAssertEqual([readPath, content.filePath, content.content ?? ""], ["/repo/a.txt", "/repo/a.txt", "hi"])

        guard case .fsWriteResult(_, let write) = events(
            .fsWriteFile(filePath: "/repo/a.txt", content: "hi"), "fs.writeFile", .object(["ok": .bool(true)])
        ).first else { return XCTFail("expected a write result") }
        XCTAssertEqual(write.filePath, "/repo/a.txt")
        XCTAssertTrue(write.ok)

        guard case .fsRenameResult(_, _, let rename) = events(
            .fsRename(oldPath: "/repo/a.txt", newPath: "/repo/b.txt"), "fs.rename",
            .object(["ok": .bool(false), "error": .string("exists")])
        ).first else { return XCTFail("expected a rename result") }
        XCTAssertEqual([rename.oldPath, rename.newPath, rename.error ?? ""], ["/repo/a.txt", "/repo/b.txt", "exists"])
        XCTAssertFalse(rename.ok)
    }

    // MARK: - Terminals

    func testAddingAnInstanceReadsThePaneBackAndReportsTheWholePane() {
        let command = RemoteCommand.terminalAddInstance(tabId: "t1")
        // The add answers an id, which is not a pane, so it becomes no event.
        XCTAssertEqual(events(command, "addTerminalInstance", .string("i2")).count, 0)
        XCTAssertEqual(mapping.next(for: command, after: .positional("addTerminalInstance"), result: .string("i2"))?.action, "terminal.paneSnapshot")

        let pane = JSONValue.object([
            "tabId": .string("t1"), "activeInstanceId": .string("i2"),
            "instances": .array([.object([
                "id": .string("i2"), "label": .string("Shell"), "kind": .string("user"),
                "readOnly": .bool(false), "cwd": .string("/repo"),
            ])]),
        ])
        guard case .terminalSnapshot(let tabId, let instances, let active, _) = events(command, "terminal.paneSnapshot", pane).first else {
            return XCTFail("expected the pane")
        }
        XCTAssertEqual([tabId, active ?? ""], ["t1", "i2"])
        XCTAssertEqual(instances.map(\.id), ["i2"])
    }

    // MARK: - Worktrees

    func testASyncReportsARefusalApartFromAFailure() {
        let command = RemoteCommand.worktreeSync(worktreePath: "/wt", sourceBranch: "main", repoPath: "/repo")
        guard case .worktreeOpResult(let refused) = events(command, "syncWorktree", .object([
            "ok": .bool(false), "refusedDirty": .bool(true), "error": .string("the worktree has uncommitted work"),
        ])).first else { return XCTFail("expected an op result") }
        XCTAssertEqual(refused.operation, .sync)
        XCTAssertEqual(refused.refusedDirty, true)
        XCTAssertEqual(refused.error, "the worktree has uncommitted work")

        guard case .worktreeOpResult(let failed) = mapping.events(
            for: command, call: .positional("syncWorktree"),
            failure: .failed(code: "action_failed", message: "git is missing")).first
        else { return XCTFail("expected an op result") }
        XCTAssertFalse(failed.ok)
        XCTAssertNil(failed.refusedDirty)
    }

    func testTheBenchAssistRecoversFirstAndOpensTheConversationOnWhatItFound() {
        let command = RemoteCommand.benchConflictAssist(repoPath: "/repo", sourceBranch: "main")
        XCTAssertEqual(events(command, "benchResolveConflict", .string("/repo/.ion/bench")).count, 0)
        let next = mapping.next(for: command, after: .positional("benchResolveConflict"), result: .string("/repo/.ion/bench"))
        XCTAssertEqual(next?.action, "openConflictAssist")
        XCTAssertEqual(next?.args, [.string("/repo/.ion/bench")])

        guard case .worktreeOpResult(let opened) = events(command, "openConflictAssist", .string("tab-7")).first else {
            return XCTFail("expected an op result")
        }
        XCTAssertEqual(opened.operation, .conflictAssist)
        XCTAssertEqual(opened.tabId, "tab-7")

        // Nothing conflicted: the chain ends and says so.
        guard case .worktreeOpResult(let none) = events(command, "benchResolveConflict", .null).first else {
            return XCTFail("expected a refusal")
        }
        XCTAssertFalse(none.ok)
        XCTAssertNil(mapping.next(for: command, after: .positional("benchResolveConflict"), result: .null))
    }

    // MARK: - This server's display

    func testTheDisplayAnswersWhatTheServerStored() {
        let sent = Date(timeIntervalSince1970: 1_700_000_000)
        let command = RemoteCommand.setRemoteDisplay(customName: "Studio", customIcon: "star", updatedAt: sent)
        guard case .remoteDisplay(let name, let icon, let storedAt) = events(command, "remote.setDisplay", .object([
            "customName": .string("Older name"), "customIcon": .null, "updatedAt": .double(1_700_000_500_000),
        ])).first else { return XCTFail("expected the display") }
        // A write that lost to a newer one answers the stored value, not ours.
        XCTAssertEqual(name, "Older name")
        XCTAssertNil(icon)
        XCTAssertEqual(storedAt, Date(timeIntervalSince1970: 1_700_000_500))
    }
}
