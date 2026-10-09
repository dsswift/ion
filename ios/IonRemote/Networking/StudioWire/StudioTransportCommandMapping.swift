import Foundation

/// Every `RemoteCommand` as the Studio wire carries it.
///
/// The table is written from `packages/shared/src/studio-wire/phone-command-map.json`,
/// which names the `studio_action` (or frame) that replaces each `desktop_*`
/// command, and `StudioCommandMapTests` fails when the two disagree.
///
/// The switch below has NO `default:` case on purpose: a command added to
/// `RemoteCommand` is a compile error here rather than a command that is
/// silently never sent. The result mapping in
/// `StudioTransportCommandMapping+Events.swift` is keyed off the same cases and
/// is reached from here, so a new command's author lands in both.
struct StudioTransportCommandMapping: StudioCommandMapping {

    /// The bench directory for a repository's source branch, which only the
    /// client's own worktree state knows. `benchRerereDiscardAll` names that
    /// path and the command that reaches it names the branch instead, so
    /// without a resolver the command is dropped rather than guessed at.
    var benchPath: (@Sendable (_ repoPath: String, _ sourceBranch: String) -> String?)?

    init(benchPath: (@Sendable (_ repoPath: String, _ sourceBranch: String) -> String?)? = nil) {
        self.benchPath = benchPath
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    func request(for command: RemoteCommand) -> StudioCommandRequest? {
        switch command {

        // ── The connection itself ──
        case .sync:
            return .snapshotRequest
        case .requestResend:
            return .drop(reason: "the Studio wire has no sequence numbers; a gap is healed by a resync")
        case .desktopAuth:
            return .drop(reason: "a bearer token rides the hello on the Studio wire, not a command")
        case .reportMobileAuth:
            return .drop(reason: "the paired credential carries this client's identity")
        case .unpair:
            return .action(.positional("auth.forgetSelf"))
        case .loadConversation(let tabId, let before, let pageSize, let held):
            return .bodyRequest(StudioBodyRequest(
                tabId: tabId, instanceId: nil, before: before, limit: pageSize ?? Self.defaultHistoryPageSize, held: held))
        case .loadDispatchTranscript(let tabId, let conversationId, let dispatchId, let before, let pageSize, let held):
            return .bodyRequest(StudioBodyRequest(
                tabId: tabId, instanceId: nil, before: before, limit: pageSize,
                conversationId: conversationId, dispatchId: dispatchId, held: held))
        case .reportFocus(let tabId, let interceptEnabled):
            let focus = StudioActionCall.positional(
                "presence.focus", .maybe(tabId), .null, .object(["interceptEnabled": .bool(interceptEnabled)]))
            guard let tabId else { return .action(focus) }
            return .action(focus, followUps: [.positional("markTabRead", .string(tabId))])
        case .diagnosticLogsResponse(let logs, let pairingId, let nextSeq, let withheldUnstamped, let withheldOtherPairing):
            return .action(.fields("clientLog.append", [
                "lines": .string(logs), "nextSeq": .int(nextSeq), "pairingId": .string(pairingId),
                "withheldUnstamped": .int(withheldUnstamped), "withheldOtherPairing": .int(withheldOtherPairing),
            ]))

        // ── Conversations ──
        case .createTab(let workingDirectory, let profileId, _, let clientCmdId, let useWorktree, let sourceBranch,
                        let ephemeralWorktree, let rememberWorktreeChoice):
            // `extensions` is not sent: the profile the server resolves names them.
            return .action(.fields("tabs.create", [
                "workingDirectory": workingDirectory.map(JSONValue.string), "profileId": profileId.map(JSONValue.string),
                "useWorktree": useWorktree.map(JSONValue.bool), "sourceBranch": sourceBranch.map(JSONValue.string),
                "ephemeralWorktree": ephemeralWorktree.map(JSONValue.bool),
                "rememberWorktreeChoice": rememberWorktreeChoice.map(JSONValue.bool),
                "clientCmdId": clientCmdId.map(JSONValue.string),
            ]))
        case .createTerminalTab(let workingDirectory, let clientCmdId):
            return .action(.fields("tabs.createTerminal", [
                "workingDirectory": workingDirectory.map(JSONValue.string), "clientCmdId": clientCmdId.map(JSONValue.string),
            ]))
        case .closeTab(let tabId):
            return .action(.fields("tabs.close", ["tabId": .string(tabId)]))
        case .prompt(let tabId, let text, _, let clientMsgId, let attachments, let implementationPhase, let instanceId, let traceparent):
            // `origin` is not sent: the server stamps the caller itself.
            var call = StudioActionCall.fields("session.prompt", [
                "tabId": .string(tabId), "text": .string(text),
                "attachments": attachments.map { .passthrough($0, what: "prompt attachments") },
                "clientMsgId": clientMsgId.map(JSONValue.string), "instanceId": instanceId.map(JSONValue.string),
                "implementationPhase": implementationPhase.map(JSONValue.bool),
                "traceparent": traceparent.map(JSONValue.string),
            ])
            // The same traceparent rides the frame's outer envelope, the only part a relay reads.
            call.traceparent = traceparent
            return .action(call)
        case .cancel(let tabId, let scope):
            return .action(.positional("interrupt", .string(tabId), .maybe(scope)))
        case .abortDispatch(let tabId, let dispatchId):
            return .action(.positional("abortDispatch", .string(tabId), .string(dispatchId)))
        case .stopBackgroundTask(let tabId, let taskId, _):
            // `requestId` stays client-side; it is echoed back on the result event.
            return .action(.positional("stopBackgroundTask", .string(tabId), .string(taskId)))
        case .respondPermission(let tabId, let questionId, let optionId):
            return .action(.positional("respondPermission", .string(tabId), .string(questionId), .string(optionId)))
        case .respondElicitation(let tabId, let requestId, let response, let cancelled, _):
            return .action(.positional(
                "respondElicitation", .string(tabId), .string(requestId),
                .passthrough(response, what: "elicitation response"), .bool(cancelled)))
        case .setPermissionMode(let tabId, let mode):
            return .action(.fields("session.setPermissionMode", ["tabId": .string(tabId), "mode": .string(mode.rawValue)]))
        case .setThinkingEffort(let tabId, let effort):
            return .action(.fields("session.setThinkingEffort", ["tabId": .string(tabId), "effort": .string(effort)]))
        case .setDraft(let tabId, let text):
            return .action(.positional("setDraftInput", .string(tabId), .string(text)))
        case .systemMetricsWatch(let on):
            return .action(.fields("environment.systemMetrics.watch", ["on": .bool(on)]))
        case .resetTabSession(let tabId):
            return .action(.fields("session.resetTab", ["tabId": .string(tabId)]))
        case .resetEngineSession(let tabId, let instanceId):
            return .action(.fields("engine.resetInstance", ["tabId": .string(tabId), "instanceId": .string(instanceId)]))
        case .requestTranscript(let tabId, _):
            return .pagedAction(.fields("session.loadTranscript", ["tabId": .string(tabId), "offset": .int(0)]))
        case .forkFromMessage(let tabId, let messageId):
            return .action(.fields("session.forkFromMessage", ["tabId": .string(tabId), "messageId": .string(messageId)]))
        case .engineRewind(let tabId, let instanceId, let messageId, let userTurnIndex):
            return .action(.fields("engine.rewind", [
                "tabId": .string(tabId), "instanceId": .string(instanceId), "messageId": .string(messageId),
                "userTurnIndex": userTurnIndex.map(JSONValue.int),
            ]))
        case .engineAbort(let tabId, _):
            return .action(.fields("engine.abort", ["tabId": .string(tabId)]))
        case .engineDialogResponse(let tabId, let dialogId, let value, _):
            return .action(.positional("respondEngineDialog", .string(tabId), .string(dialogId), .string(value)))
        case .engineSetModel(let tabId, let model, _):
            return .action(.positional("setTabModel", .string(tabId), .string(model), .null))
        case .setTabModel(let tabId, let model, let providerId):
            return .action(.positional("setTabModel", .string(tabId), .string(model), .maybe(providerId)))
        case .declarePreferences(let preferences):
            return .action(.positional("preferences.declare", .object(preferences)))
        case .registerPush(let token, let env):
            return .action(.fields("device.registerPush", ["token": .string(token), "env": .string(env)]))
        case .requestAgentState(let tabId, let instanceId):
            return .action(.fields("engine.agentState", ["tabId": .string(tabId), "instanceId": instanceId.map(JSONValue.string)]))
        case .requestContextBreakdown(let tabId):
            return .action(.fields("engine.contextBreakdown", ["key": .string(tabId)]))
        case .loadAttachments(let tabId):
            return .action(.fields("session.tabAttachments", ["tabId": .string(tabId)]))
        case .listBranches(let tabId):
            return .action(.fields("engine.listBranches", ["key": .string(tabId)]))
        case .switchBranch(let tabId, let leafId):
            return .action(.fields("engine.switchBranch", ["key": .string(tabId), "leafId": .string(leafId)]))
        case .implementPlan(let tabId, let questionId, let instanceId, let clearContext):
            return .action(.fields("session.implementPlan", [
                "tabId": .string(tabId), "questionId": .string(questionId),
                "instanceId": instanceId.map(JSONValue.string), "clearContext": .bool(clearContext),
            ]))
        case .requestPlanContent(_, let questionId, let planFilePath, let offset, let length):
            // `tabId` stays client-side: the plan is read from disk by path.
            return .action(.fields("session.readPlan", [
                "planFilePath": .string(planFilePath), "questionId": .string(questionId),
                "offset": .int(offset), "length": .int(length),
            ]))
        case .discoverCommands(let directory):
            return .action(.positional("session.discoverCommands", .string(directory)))
        case .voiceConfig(let enabled, let mode, let systemPrompt):
            return .action(.fields("voice.setConfig", [
                "enabled": .bool(enabled), "mode": .string(mode), "systemPrompt": systemPrompt.map(JSONValue.string),
            ]))

        // ── Tabs, groups, and the inbox ──
        case .renameTab(let tabId, let customTitle):
            return .action(.positional("renameTab", .string(tabId), .maybe(customTitle)))
        case .renameTerminalInstance(let tabId, let instanceId, let label):
            return .action(.positional("renameTerminalInstance", .string(tabId), .string(instanceId), .string(label)))
        case .setPillColor(let tabId, let pillColor):
            return .action(.positional("setTabPillColor", .string(tabId), .maybe(pillColor)))
        case .tabSettle(let tabId):
            return .action(.positional("settleTab", .string(tabId)))
        case .tabUnsettle(let tabId):
            return .action(.positional("unsettleTab", .string(tabId), .string("user")))
        case .tabDelete(let tabId):
            return .action(.positional("deleteConversationTab", .string(tabId)))
        case .reviewSettledTab(let tabId):
            return .action(.positional("restoreSettledHistoryTab", .string(tabId)))
        case .tabSnooze(let tabId, let untilMs):
            return .action(.positional("snoozeTab", .string(tabId), .double(untilMs)))
        case .tabUnsnooze(let tabId):
            return .action(.positional("unsnoozeTab", .string(tabId)))
        case .tabResumeAtReset(let tabId):
            return .action(.positional("resumeAtLimitReset", .string(tabId)))
        case .tabSnoozeUntilReset(let tabId):
            return .action(.positional("snoozeUntilLimitReset", .string(tabId)))
        case .tabQueueSpareQuota(let tabId, let text):
            return .action(.positional("deferSend", .string(tabId), .string(text), .string("spare-quota")))
        case .tabCancelHeldPrompt(let tabId):
            return .action(.positional("cancelDeferredSend", .string(tabId)))
        case .tabSendHeldPrompt(let tabId):
            return .action(.positional("releaseDeferredSend", .string(tabId)))
        case .tabMarkUnread(let tabId):
            return .action(.positional("markTabUnread", .string(tabId)))
        case .tabPin(let tabId):
            return .action(.positional("pinTab", .string(tabId)))
        case .tabUnpin(let tabId):
            return .action(.positional("unpinTab", .string(tabId)))
        case .tabRegenerateTitle(let tabId):
            return .action(.positional("regenerateTabTitle", .string(tabId)))
        case .tabReorderPin(let assignments):
            return .action(.positional("reorderPinnedTabs", .array(assignments.map {
                .object(["id": .string($0.tabId), "orderKey": .string($0.orderKey)])
            })))

        // ── Terminals ──
        case .terminalInput(let tabId, let instanceId, let data):
            return .action(.fields("terminal.write", ["key": .string(Self.paneKey(tabId, instanceId)), "data": .string(data)]))
        case .terminalResize(let tabId, let instanceId, let cols, let rows):
            return .action(.fields("terminal.resize", [
                "key": .string(Self.paneKey(tabId, instanceId)), "cols": .int(cols), "rows": .int(rows),
            ]))
        case .terminalAddInstance(let tabId):
            return .action(.positional("addTerminalInstance", .string(tabId), .string("user")))
        case .runQuickTool(let tabId, let toolId):
            return .action(.positional("runQuickTool", .string(tabId), .string(toolId)))
        case .terminalRemoveInstance(let tabId, let instanceId):
            return .action(.positional("removeTerminalInstance", .string(tabId), .string(instanceId)))
        case .terminalSelectInstance(let tabId, let instanceId):
            return .action(.positional("selectTerminalInstance", .string(tabId), .string(instanceId)))
        case .requestTerminalSnapshot(let tabId):
            return .action(.fields("terminal.paneSnapshot", ["tabId": .string(tabId)]))
        case .openTerminalApplication(let tabId, let url):
            return .action(.fields("terminal.openApplication", ["tabId": .string(tabId), "url": .string(url)]))

        // ── Git ──
        case .gitChanges(let directory):
            return .action(Self.gitChanges(directory))
        case .gitBranches(let directory):
            return .action(.fields("git.branches", ["directory": .string(directory), "localOnly": .bool(true)]))
        case .gitGraph(let directory, let skip, let limit):
            return .action(Self.gitGraph(directory, skip: skip, limit: limit))
        case .gitDiff(let directory, let path, let staged):
            return .action(.fields("git.diff", ["directory": .string(directory), "path": .string(path), "staged": .bool(staged)]))
        case .gitStage(let directory, let paths):
            return .action(.fields("git.stage", ["directory": .string(directory), "paths": .array(paths.map(JSONValue.string))]))
        case .gitUnstage(let directory, let paths):
            return .action(.fields("git.unstage", ["directory": .string(directory), "paths": .array(paths.map(JSONValue.string))]))
        case .gitDiscard(let directory, let paths):
            return .action(.fields("git.discard", ["directory": .string(directory), "paths": .array(paths.map(JSONValue.string))]))
        case .gitCommit(let directory, let message):
            return .action(.fields("git.commit", ["directory": .string(directory), "message": .string(message)]))
        case .gitFetch(let directory):
            return .action(.fields("git.fetch", ["directory": .string(directory)]))
        case .gitPull(let directory):
            return .action(.fields("git.pull", ["directory": .string(directory)]))
        case .gitPush(let directory):
            return .action(.fields("git.push", ["directory": .string(directory)]))
        case .gitCommitFiles(let directory, let hash):
            return .action(.fields("git.commitFiles", ["directory": .string(directory), "hash": .string(hash)]))
        case .gitCommitFileDiff(let directory, let hash, let path):
            return .action(.fields("git.commitFileDiff", [
                "directory": .string(directory), "hash": .string(hash), "path": .string(path),
            ]))

        // ── Files ──
        case .fsListDir(let directory, let includeHidden):
            return .action(.fields("fs.readDir", ["directory": .string(directory), "includeHidden": .bool(includeHidden)]))
        case .fsReadFile(let filePath):
            return .action(.fields("fs.readFile", ["filePath": .string(filePath)]))
        case .fsReadImage(let filePath):
            return .action(.positional("session.readImageDataUrl", .string(filePath), .object(["maxBytes": .int(Self.imageMaxBytes)])))
        case .fsWriteFile(let filePath, let content):
            return .action(.fields("fs.writeFile", ["filePath": .string(filePath), "content": .string(content)]))
        case .fsRename(let oldPath, let newPath):
            return .action(.fields("fs.rename", ["oldPath": .string(oldPath), "newPath": .string(newPath)]))
        case .uploadAttachment(let dataUrl, let name, _):
            // `correlationId` stays client-side and is echoed back on the result event.
            return .action(.fields("fs.saveAttachmentData", ["name": .string(name), "dataUrl": .string(dataUrl)]))
        case .requestThemeAsset(let themeId, let slot):
            return .action(.fields("studio.readThemeAsset", ["themeId": .string(themeId), "slot": .string(slot)]))

        // ── This server's own settings and display ──
        case .setDesktopSetting(let key, let value):
            return .action(.fields("settings.setProjectable", [
                "key": .string(key), "value": .passthrough(value, what: "server setting \(key)"),
            ]))
        case .setRemoteDisplay(let customName, let customIcon, let updatedAt):
            return .action(.positional(
                "remote.setDisplay", .maybe(customName), .maybe(customIcon),
                .double(updatedAt.timeIntervalSince1970 * 1000)))

        // ── Resources ──
        case .requestResourceContent(let kind, let producer, let resourceId):
            return .action(.fields("resource.get", [
                "kind": .string(kind), "id": .string(resourceId),
                "producer": producer.map(JSONValue.string), "fromCatalog": .bool(true),
            ]))
        case .markResourceRead(let kind, let producer, let resourceId):
            return .action(.fields("resource.markRead", [
                "kind": .string(kind), "resourceId": .string(resourceId), "producer": producer.map(JSONValue.string),
            ]))
        case .deleteResource(let kind, let producer, let resourceId):
            return .action(.fields("resource.delete", [
                "kind": .string(kind), "resourceId": .string(resourceId), "producer": producer.map(JSONValue.string),
            ]))

        // ── Guided questions ──
        case .questionsPatch(_, let patch):
            return .action(.positional("questions.patch", .passthrough(patch, what: "questions patch")))
        case .questionsAction(_, let action):
            return .action(.positional("questions.action", .passthrough(action, what: "questions action")))
        case .questionsRefresh:
            return .action(.positional("questions.getState"))

        // ── Worktrees and the integration bench ──
        case .worktreeRefresh(let repoPath):
            return .action(.fields("worktree.state", ["repoPath": .string(repoPath)]))
        case .worktreeOpenConversation(let worktreePath, let newConversation):
            return .action(.positional(newConversation ? "newWorktreeConversation" : "openWorktreeConversation", .string(worktreePath)))
        case .worktreeSync(let worktreePath, let sourceBranch, let repoPath):
            return .action(.positional("syncWorktree", .string(worktreePath), .string(sourceBranch), .string(repoPath)))
        case .worktreeSyncAll(let repoPath):
            return .action(.fields("worktree.syncAll", ["repoPath": .string(repoPath)]))
        case .worktreeLandAndRetire(let repoPath, let worktreePath, let worktreeBranch, let sourceBranch):
            return .action(.positional("landAndRetireWorktree", .string(repoPath), .object([
                "worktreePath": .string(worktreePath), "branchName": .string(worktreeBranch),
                "sourceBranch": .string(sourceBranch), "label": .string(worktreeBranch),
            ])))
        case .worktreeCreate(let repoPath, let sourceBranch):
            return .action(.positional("createWorktree", .string(repoPath), .string(sourceBranch)))
        case .worktreeConvertConversation(let tabId):
            return .action(.positional("convertToWorktree", .string(tabId)))
        case .worktreeRename(let repoPath, let worktreePath, let title):
            return .action(.positional("renameWorktree", .string(repoPath), .string(worktreePath), .string(title)))
        case .worktreeReprovision(let repoPath, let worktreePath):
            return .action(.positional("reprovisionWorktree", .string(repoPath), .string(worktreePath)))
        case .worktreeRetire(let repoPath, let worktreePath, let branchName):
            return .action(.positional("retireWorktree", .string(repoPath), .string(worktreePath), .string(branchName)))
        case .worktreeRetireLanded(let repoPath):
            return .action(.positional("retireLandedWorktrees", .string(repoPath)))
        case .worktreeSetStage(let repoPath, let worktreePath, let stage):
            return .action(.positional("setWorktreeStage", .string(repoPath), .string(worktreePath), .maybe(stage)))
        case .worktreeConflictAssist(_, let worktreePath):
            return .action(.positional("openConflictAssist", .string(worktreePath)))
        case .benchOpenConversation(let repoPath, let sourceBranch):
            return .action(.positional("openBenchConversation", .string(repoPath), .string(sourceBranch)))
        case .benchOpenTerminal(let repoPath, let sourceBranch):
            return .action(.positional("openBenchTerminal", .string(repoPath), .string(sourceBranch)))
        case .benchAssemble(let repoPath, let sourceBranch):
            return .action(.positional("benchAssemble", .string(repoPath), .string(sourceBranch)))
        case .benchUpdateMember(let repoPath, let sourceBranch, let worktreePath):
            return .action(.positional("benchUpdateMember", .string(repoPath), .string(sourceBranch), .string(worktreePath)))
        case .benchUpdateAll(let repoPath, let sourceBranch):
            return .action(.positional("benchUpdateAll", .string(repoPath), .string(sourceBranch)))
        case .benchAddMember(let repoPath, let sourceBranch, let worktreePath, let branchName):
            return .action(.positional(
                "benchAddMember", .string(repoPath), .string(sourceBranch), .string(worktreePath), .string(branchName)))
        case .benchRemoveMember(let repoPath, let sourceBranch, let worktreePath):
            return .action(.positional("benchRemoveMember", .string(repoPath), .string(sourceBranch), .string(worktreePath)))
        case .benchReorderMember(let repoPath, let sourceBranch, let worktreePath, let toIndex):
            return .action(.positional(
                "benchSetOrder", .string(repoPath), .string(sourceBranch), .string(worktreePath), .int(toIndex)))
        case .benchRecoverConflict(let repoPath, let sourceBranch), .benchConflictAssist(let repoPath, let sourceBranch):
            // One action for both: recovery answers the bench path, and the
            // assist verb opens a conversation on it (see `next`).
            return .action(.positional("benchResolveConflict", .string(repoPath), .string(sourceBranch)))
        case .benchAnalyseVerification(let repoPath, let sourceBranch):
            return .action(.positional("openBenchVerificationAnalysis", .string(repoPath), .string(sourceBranch)))
        case .benchDiscardMemberRecordings(let repoPath, let sourceBranch, let branchNames):
            return .action(.positional(
                "benchDiscardMemberRecordings", .string(repoPath), .string(sourceBranch),
                .array(branchNames.map(JSONValue.string))))
        case .benchDiscardAllRecordings(let repoPath, let sourceBranch):
            guard let path = benchPath?(repoPath, sourceBranch) else {
                return .drop(reason: "this client holds no bench path for \(sourceBranch); a worktree refresh supplies one")
            }
            return .action(.positional("benchRerereDiscardAll", .string(path)),
                           followUps: [.positional("refreshBench", .string(repoPath))])
        case .worktreePipelineStart(let repoPath, let sourceBranch):
            return .action(.positional("startWorktreePipeline", .string(repoPath), .string(sourceBranch)))
        case .worktreePipelineConfirmAi:
            return .action(.positional("confirmWorktreePipelineAi"))
        case .worktreePipelineCancel:
            return .action(.positional("cancelWorktreePipeline"))
        case .worktreePipelineDismiss:
            return .action(.positional("dismissWorktreePipeline"))
        }
    }

    // MARK: - Calls reused by `next`

    static func gitChanges(_ directory: String) -> StudioActionCall {
        .fields("git.changes", ["directory": .string(directory)])
    }

    static func gitGraph(_ directory: String, skip: Int? = nil, limit: Int? = nil) -> StudioActionCall {
        .fields("git.graph", [
            "directory": .string(directory), "skip": skip.map(JSONValue.int),
            "limit": limit.map(JSONValue.int), "withLayout": .bool(true),
        ])
    }

    /// How `terminal.write` and `terminal.resize` name one pane.
    static func paneKey(_ tabId: String, _ instanceId: String) -> String { "\(tabId):\(instanceId)" }

    /// A `studio_body_request` with neither `before` nor `limit` is answered
    /// with the whole transcript in one frame, so a first-page request always
    /// names a limit. The server raises a smaller limit to its own minimum page.
    static let defaultHistoryPageSize = 10

    /// The ceiling the phone puts on one inlined image, matching what the
    /// `desktop_*` wire's image read allowed.
    static let imageMaxBytes = 10_485_760

    /// Commands the shared map still describes and this client has no case
    /// for. The server ignores all four — a conversation holds one engine
    /// instance — so the client stopped having a way to send them rather than
    /// sending something that is dropped on arrival.
    static let commandsThisClientNeverSends: Set<String> = [
        "desktop_engine_add_instance", "desktop_engine_remove_instance",
        "desktop_engine_select_instance", "desktop_engine_move_instance",
    ]
}
