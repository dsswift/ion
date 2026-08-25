import Foundation

// MARK: - Centralized Command Logging

extension DiagnosticLog {

    /// Log a structured one-liner for any outbound RemoteCommand.
    /// Called from `send()` before the command is dispatched to transport.
    static func logCommand(_ command: RemoteCommand) {
        switch command {
        case .sync:
            log("CMD: sync", tag: "ipc", level: .info)

        case .createTab(let dir, let pinToGroupId, let profileId, _, _, let useWorktree, let sourceBranch):
            if let profileId {
                log("CMD: createTab(engine) dir=\(dir?.suffix(30) ?? "nil") profile=\(profileId) pinToGroup=\(pinToGroupId?.prefix(8) ?? "nil")", tag: "ipc", level: .info)
            } else {
                log("CMD: createTab dir=\(dir?.suffix(30) ?? "nil") pinToGroup=\(pinToGroupId?.prefix(8) ?? "nil")", tag: "ipc", level: .info)
            }
            if useWorktree == true || sourceBranch != nil {
                log("CMD: createTab worktree source=\(sourceBranch ?? "default")", tag: "ipc", level: .info)
            }

        // ── Worktree + integration bench ──
        case .worktreeRefresh(let repoPath):
            log("CMD: worktreeRefresh repo=\(repoPath.suffix(30))", tag: "ipc", level: .debug)
        case .worktreeOpenConversation(let worktreePath, let newConversation):
            log("CMD: worktreeOpenConversation wt=\(worktreePath.suffix(30)) new=\(newConversation)", tag: "ipc", level: .info)
        case .worktreeSync(let worktreePath, let sourceBranch, _):
            log("CMD: worktreeSync wt=\(worktreePath.suffix(30)) source=\(sourceBranch)", tag: "ipc", level: .info)
        case .worktreeSyncAll(let repoPath):
            log("CMD: worktreeSyncAll repo=\(repoPath.suffix(30))", tag: "ipc", level: .info)
        case .worktreeLandAndRetire(_, let worktreePath, let worktreeBranch, let sourceBranch):
            log("CMD: worktreeLandAndRetire wt=\(worktreePath.suffix(30)) branch=\(worktreeBranch) source=\(sourceBranch)", tag: "ipc", level: .info)
        case .benchOpenConversation(_, let sourceBranch):
            log("CMD: benchOpenConversation source=\(sourceBranch)", tag: "ipc", level: .info)
        case .benchOpenTerminal(_, let sourceBranch):
            log("CMD: benchOpenTerminal source=\(sourceBranch)", tag: "ipc", level: .info)
        case .benchAssemble(_, let sourceBranch):
            log("CMD: benchAssemble source=\(sourceBranch)", tag: "ipc", level: .info)
        case .benchUpdateMember(_, let sourceBranch, let worktreePath):
            log("CMD: benchUpdateMember source=\(sourceBranch) wt=\(worktreePath.suffix(30))", tag: "ipc", level: .info)
        case .benchUpdateAll(_, let sourceBranch):
            log("CMD: benchUpdateAll source=\(sourceBranch)", tag: "ipc", level: .info)
        case .worktreeSetStage(_, let worktreePath, let stage):
            log("CMD: worktreeSetStage wt=\(worktreePath.suffix(30)) stage=\(stage ?? "none")", tag: "ipc", level: .info)
        case .benchReorderMember(_, let sourceBranch, let worktreePath, let toIndex):
            log("CMD: benchReorderMember source=\(sourceBranch) wt=\(worktreePath.suffix(30)) to=\(toIndex)", tag: "ipc", level: .info)
        case .benchAddMember(_, let sourceBranch, _, let branchName):
            log("CMD: benchAddMember source=\(sourceBranch) branch=\(branchName)", tag: "ipc", level: .info)
        case .benchRemoveMember(_, let sourceBranch, let worktreePath):
            log("CMD: benchRemoveMember source=\(sourceBranch) wt=\(worktreePath.suffix(30))", tag: "ipc", level: .info)

        case .worktreeRetireLanded(let repoPath):
            log("CMD: worktreeRetireLanded repo=\(repoPath.suffix(30))", tag: "ipc", level: .info)
        case .worktreeCreate(let repoPath, let sourceBranch):
            log("CMD: worktreeCreate repo=\(repoPath.suffix(30)) source=\(sourceBranch)", tag: "ipc", level: .info)
        case .worktreeConvertConversation(let tabId):
            log("CMD: worktreeConvertConversation tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .worktreeRename(_, let worktreePath, let title):
            log("CMD: worktreeRename wt=\(worktreePath.suffix(30)) title=\(title.prefix(30))", tag: "ipc", level: .info)
        case .worktreeReprovision(_, let worktreePath):
            log("CMD: worktreeReprovision wt=\(worktreePath.suffix(30))", tag: "ipc", level: .info)
        case .benchRecoverConflict(_, let sourceBranch):
            log("CMD: benchRecoverConflict source=\(sourceBranch)", tag: "ipc", level: .info)
        case .benchAnalyseVerification(_, let sourceBranch):
            log("CMD: benchAnalyseVerification source=\(sourceBranch)", tag: "ipc", level: .info)
        case .benchDiscardMemberRecordings(_, let sourceBranch, let branchNames):
            log("CMD: benchDiscardMemberRecordings source=\(sourceBranch) branches=\(branchNames.count)", tag: "ipc", level: .info)
        case .benchDiscardAllRecordings(_, let sourceBranch):
            log("CMD: benchDiscardAllRecordings source=\(sourceBranch)", tag: "ipc", level: .info)
        case .worktreeRetire(_, let worktreePath, _):
            log("CMD: worktreeRetire path=\(worktreePath.suffix(30))", tag: "ipc", level: .info)
        case .worktreeConflictAssist(_, let worktreePath):
            log("CMD: worktreeConflictAssist path=\(worktreePath.suffix(30))", tag: "ipc", level: .info)
        case .benchConflictAssist(_, let sourceBranch):
            log("CMD: benchConflictAssist source=\(sourceBranch)", tag: "ipc", level: .info)
        case .worktreePipelineStart(let repoPath, let sourceBranch):
            log("CMD: worktreePipelineStart repo=\(repoPath.suffix(30)) source=\(sourceBranch)", tag: "ipc", level: .info)
        case .worktreePipelineConfirmAi(let repoPath):
            log("CMD: worktreePipelineConfirmAi repo=\(repoPath.suffix(30))", tag: "ipc", level: .info)
        case .worktreePipelineCancel(let repoPath):
            log("CMD: worktreePipelineCancel repo=\(repoPath.suffix(30))", tag: "ipc", level: .info)
        case .worktreePipelineDismiss(let repoPath):
            log("CMD: worktreePipelineDismiss repo=\(repoPath.suffix(30))", tag: "ipc", level: .info)

        case .createTerminalTab(let dir, _):
            log("CMD: createTerminalTab dir=\(dir?.suffix(30) ?? "nil")", tag: "ipc", level: .info)

        case .closeTab(let tabId):
            log("CMD: closeTab tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)

        case .resetTabSession(let tabId):
            log("CMD: resetTabSession tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .resetEngineSession(let tabId, let instanceId):
            log("CMD: resetEngineSession tabId=\(tabId.prefix(8)) instanceId=\(instanceId.prefix(8))", tag: "ipc", level: .info)

        case .prompt(let tabId, let text, _, let clientMsgId, let attachments, _, let instanceId):
            if let instanceId {
                log("CMD: prompt(engine) tabId=\(tabId.prefix(8)) len=\(text.count) inst=\(instanceId.prefix(8)) att=\(attachments?.count ?? 0)", tag: "ipc", level: .info)
            } else {
                log("CMD: prompt tabId=\(tabId.prefix(8)) len=\(text.count) msgId=\(clientMsgId?.prefix(8) ?? "nil") att=\(attachments?.count ?? 0)", tag: "ipc", level: .info)
            }

        case .cancel(let tabId, let scope):
            log("CMD: cancel tabId=\(tabId.prefix(8)) scope=\(scope ?? "all")", tag: "ipc", level: .info)

        case .abortDispatch(let tabId, let dispatchId):
            log("CMD: abortDispatch tabId=\(tabId.prefix(8)) dispatchId=\(dispatchId.prefix(24))", tag: "ipc", level: .info)
        case .stopBackgroundTask(let tabId, let taskId, let requestId):
            log("background task stop command", tag: "ipc", level: .info, fields: [
                "tab_id": tabId,
                "task_id": taskId,
                "request_id": requestId,
            ])

        case .respondPermission(let tabId, let qId, let optId):
            log("CMD: respondPermission tabId=\(tabId.prefix(8)) qId=\(qId.prefix(8)) opt=\(optId)", tag: "ipc", level: .info)

        case .respondElicitation(let tabId, let requestId, _, let cancelled, let declined):
            log("CMD: respondElicitation tabId=\(tabId.prefix(8)) requestId=\(requestId.prefix(12)) cancelled=\(cancelled) declined=\(declined)", tag: "ipc", level: .info)

        case .setPermissionMode(let tabId, let mode):
            log("CMD: setPermissionMode tabId=\(tabId.prefix(8)) mode=\(mode.rawValue)", tag: "ipc", level: .info)

        case .setThinkingEffort(let tabId, let effort):
            log("CMD: setThinkingEffort tabId=\(tabId.prefix(8)) effort=\(effort)", tag: "ipc", level: .info)

        // ── Inbox actions ──
        case .tabSettle(let tabId):
            log("CMD: tabSettle tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .tabDelete(let tabId):
            log("CMD: tabDelete tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .tabUnsettle(let tabId):
            log("CMD: tabUnsettle tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .tabSnooze(let tabId, let untilMs):
            log("CMD: tabSnooze tabId=\(tabId.prefix(8)) until=\(Int(untilMs))", tag: "ipc", level: .info)
        case .tabUnsnooze(let tabId):
            log("CMD: tabUnsnooze tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .tabMarkUnread(let tabId):
            log("CMD: tabMarkUnread tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .tabPin(let tabId):
            log("CMD: tabPin tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .tabUnpin(let tabId):
            log("CMD: tabUnpin tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .tabReorderPin(let assignments):
            log("CMD: tabReorderPin assignmentCount=\(assignments.count)", tag: "ipc", level: .info)
        case .tabRegenerateTitle(let tabId):
            log("CMD: tabRegenerateTitle tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)
        case .reviewSettledTab(let tabId):
            log("CMD: reviewSettledTab tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)

        case .loadConversation(let tabId, let before):
            log("CMD: loadConversation tabId=\(tabId.prefix(8)) before=\(before?.prefix(8) ?? "nil")", tag: "ipc", level: .info)

        case .requestResend(let fromSeq, let toSeq):
            log("CMD: requestResend [\(fromSeq),\(toSeq)]", tag: "ipc", level: .info)

        case .terminalInput(let tabId, let instId, let data):
            log("CMD: terminalInput tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) len=\(data.count)", tag: "ipc", level: .info)

        case .terminalResize(let tabId, let instId, let cols, let rows):
            log("CMD: terminalResize tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) \(cols)x\(rows)", tag: "ipc", level: .info)

        case .terminalAddInstance(let tabId):
            log("CMD: terminalAddInstance tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)

        case .terminalRemoveInstance(let tabId, let instId):
            log("CMD: terminalRemoveInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))", tag: "ipc", level: .info)

        case .terminalSelectInstance(let tabId, let instId):
            log("CMD: terminalSelectInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8))", tag: "ipc", level: .info)

        case .requestTerminalSnapshot(let tabId):
            log("CMD: requestTerminalSnapshot tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)

        case .requestAgentState(let tabId, let instanceId):
            log("CMD: requestAgentState tabId=\(tabId.prefix(8)) inst=\(instanceId?.prefix(8) ?? "nil")", tag: "ipc", level: .info)
        case .requestContextBreakdown(let tabId):
            log("CMD: requestContextBreakdown tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)

        case .renameTab(let tabId, let title):
            log("CMD: renameTab tabId=\(tabId.prefix(8)) title=\(title?.prefix(20) ?? "nil")", tag: "ipc", level: .info)

        case .renameTerminalInstance(let tabId, let instId, let label):
            log("CMD: renameTerminalInstance tabId=\(tabId.prefix(8)) inst=\(instId.prefix(8)) label=\(label)", tag: "ipc", level: .info)

        case .forkFromMessage(let tabId, let msgId):
            log("CMD: forkFromMessage tabId=\(tabId.prefix(8)) msgId=\(msgId.prefix(8))", tag: "ipc", level: .info)

        case .engineRewind(let tabId, let instanceId, let msgId, let userTurnIndex):
            log("CMD: engineRewind tabId=\(tabId.prefix(8)) instanceId=\(instanceId.prefix(8)) msgId=\(msgId.prefix(8)) userTurnIndex=\(userTurnIndex.map(String.init) ?? "nil")", tag: "ipc", level: .info)

        case .unpair:
            log("CMD: unpair", tag: "ipc", level: .info)

        case .engineAbort(let tabId, let instId):
            log("CMD: engineAbort tabId=\(tabId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "ipc", level: .info)

        case .engineDialogResponse(let tabId, let dId, _, let instId):
            log("CMD: engineDialogResponse tabId=\(tabId.prefix(8)) dId=\(dId.prefix(8)) inst=\(instId?.prefix(8) ?? "nil")", tag: "ipc", level: .info)

        // loadEngineConversation removed (WI-004 / #259) — no log case needed.

        case .loadAgentConversation(let conversationIds):
            log("CMD: loadAgentConversation ids=\(conversationIds.count)", tag: "ipc", level: .info)

        case .setTabGroupMode(let mode):
            log("CMD: setTabGroupMode mode=\(mode)", tag: "ipc", level: .info)

        case .moveTabToGroup(let tabId, let gId):
            log("CMD: moveTabToGroup tabId=\(tabId.prefix(8)) group=\(gId.prefix(8))", tag: "ipc", level: .info)

        case .toggleTabGroupPin(let tabId):
            log("CMD: toggleTabGroupPin tabId=\(tabId.prefix(8))", tag: "ipc", level: .info)

        case .engineSetModel(let tabId, let model, let instId):
            log("CMD: engineSetModel tabId=\(tabId.prefix(8)) model=\(model) inst=\(instId?.prefix(8) ?? "nil")", tag: "ipc", level: .info)

        case .setTabModel(let tabId, let model):
            log("CMD: setTabModel tabId=\(tabId.prefix(8)) model=\(model)", tag: "ipc", level: .info)

        case .setPreferredModel(let model):
            log("CMD: setPreferredModel model=\(model)", tag: "ipc", level: .info)

        case .setEngineDefaultModel(let model):
            log("CMD: setEngineDefaultModel model=\(model)", tag: "ipc", level: .info)

        case .gitChanges(let dir):
            log("CMD: gitChanges dir=\(dir.suffix(30))", tag: "ipc", level: .info)

        case .gitBranches(let dir):
            log("CMD: gitBranches dir=\(dir.suffix(30))", tag: "ipc", level: .info)

        case .gitGraph(let dir, _, _):
            log("CMD: gitGraph dir=\(dir.suffix(30))", tag: "ipc", level: .info)

        case .gitDiff(let dir, let path, let staged):
            log("CMD: gitDiff dir=\(dir.suffix(30)) path=\(path.suffix(30)) staged=\(staged)", tag: "ipc", level: .info)

        case .gitStage(let dir, let paths):
            log("CMD: gitStage dir=\(dir.suffix(30)) paths=\(paths.count)", tag: "ipc", level: .info)

        case .gitUnstage(let dir, let paths):
            log("CMD: gitUnstage dir=\(dir.suffix(30)) paths=\(paths.count)", tag: "ipc", level: .info)

        case .gitCommit(let dir, let msg):
            log("CMD: gitCommit dir=\(dir.suffix(30)) msg=\(msg.prefix(40))", tag: "ipc", level: .info)

        case .gitDiscard(let dir, let paths):
            log("CMD: gitDiscard dir=\(dir.suffix(30)) paths=\(paths.count)", tag: "ipc", level: .info)

        case .gitFetch(let dir):
            log("CMD: gitFetch dir=\(dir.suffix(30))", tag: "ipc", level: .info)

        case .gitPull(let dir):
            log("CMD: gitPull dir=\(dir.suffix(30))", tag: "ipc", level: .info)

        case .gitPush(let dir):
            log("CMD: gitPush dir=\(dir.suffix(30))", tag: "ipc", level: .info)

        case .gitCommitFiles(let dir, let hash):
            log("CMD: gitCommitFiles dir=\(dir.suffix(30)) hash=\(hash.prefix(8))", tag: "ipc", level: .info)

        case .gitCommitFileDiff(let dir, let hash, let path):
            log("CMD: gitCommitFileDiff dir=\(dir.suffix(30)) hash=\(hash.prefix(8)) path=\(path.suffix(30))", tag: "ipc", level: .info)

        case .fsListDir(let dir, let hidden):
            log("CMD: fsListDir dir=\(dir.suffix(30)) hidden=\(hidden)", tag: "ipc", level: .info)

        case .fsReadFile(let path):
            log("CMD: fsReadFile path=\(path.suffix(40))", tag: "ipc", level: .info)

        case .fsReadImage(let path):
            log("CMD: fsReadImage path=\(path.suffix(40))", tag: "ipc", level: .info)

        case .requestThemeAsset(let themeId, let slot):
            log("CMD: requestThemeAsset theme=\(themeId) slot=\(slot)", tag: "ipc", level: .info)

        case .fsWriteFile(let path, let content):
            log("CMD: fsWriteFile path=\(path.suffix(40)) len=\(content.count)", tag: "ipc", level: .info)

        case .fsRename(let oldPath, let newPath):
            log("CMD: fsRename old=\(oldPath.suffix(40)) new=\(newPath.suffix(40))", tag: "ipc", level: .info)

        case .discoverCommands(let dir):
            log("CMD: discoverCommands dir=\(dir.suffix(30))", tag: "ipc", level: .info)

        case .uploadAttachment(_, let name, let corrId):
            log("CMD: uploadAttachment name=\(name) corrId=\(corrId.prefix(8))", tag: "ipc", level: .info)

        case .loadAttachments(let tabId):
            log("CMD: loadAttachments tab=\(tabId.prefix(8))", tag: "ipc", level: .info)

        case .voiceConfig(let enabled, let mode, _):
            log("CMD: voiceConfig enabled=\(enabled) mode=\(mode)", tag: "ipc", level: .info)

        case .diagnosticLogsResponse(let logs, _, let nextSeq):
            log("CMD: diagnosticLogsResponse len=\(logs.count) nextSeq=\(nextSeq)", tag: "ipc", level: .info)

        case .reorderTabGroups(let orderedIds):
            log("CMD: reorderTabGroups count=\(orderedIds.count)", tag: "ipc", level: .info)

        case .setRemoteDisplay(let customName, let customIcon, let updatedAt):
            let ms = Int(updatedAt.timeIntervalSince1970 * 1000)
            log("CMD: setRemoteDisplay name=\(customName == nil ? "cleared" : "set") icon=\(customIcon ?? "cleared") ts=\(ms)", tag: "ipc", level: .info)

        case .setDesktopSetting(let key, _):
            // Log the key only — value type is loggable but the actual
            // user setting could be sensitive on future string projections.
            // Pairs with the SETTINGS-CMD line on the desktop side for
            // round-trip correlation.
            log("CMD: setDesktopSetting key=\(key)", tag: "ipc", level: .info)

        case .setPillColor(let tabId, let color):
            log("CMD: setPillColor tabId=\(tabId.prefix(8)) color=\(color ?? "nil")", tag: "ipc", level: .info)

        case .setPillIcon(let tabId, let icon):
            log("CMD: setPillIcon tabId=\(tabId.prefix(8)) icon=\(icon ?? "nil")", tag: "ipc", level: .info)

        case .reportFocus(let tabId, let interceptEnabled):
            log("CMD: reportFocus tabId=\(tabId?.prefix(8) ?? "nil") interceptEnabled=\(interceptEnabled)", tag: "ipc", level: .info)

        case .reportMobileAuth(let username, _, _, let tenant, _, let clearIdentity, let status, let reason, _):
            log("CMD: reportMobileAuth has_username=\(!(username ?? "").isEmpty) has_tenant=\(!(tenant ?? "").isEmpty) clear_identity=\(clearIdentity) status=\(status ?? "unknown") reason=\(reason ?? "none")", tag: "ipc", level: .info)

        case .requestResourceContent(let kind, let producer, let resourceId):
            log("CMD: requestResourceContent kind=\(kind) producer=\(producer) resourceId=\(resourceId.prefix(12))", tag: "ipc", level: .info)

        case .markResourceRead(let kind, let producer, let resourceId):
            log("CMD: markResourceRead kind=\(kind) producer=\(producer) resourceId=\(resourceId.prefix(12))", tag: "ipc", level: .info)

        case .deleteResource(let kind, let producer, let resourceId):
            log("CMD: deleteResource kind=\(kind) producer=\(producer) resourceId=\(resourceId.prefix(12))", tag: "ipc", level: .info)

        case .implementPlan(let tabId, let questionId, let instanceId, let clearContext):
            log("CMD: implementPlan tabId=\(tabId.prefix(8)) qId=\(questionId.prefix(12)) inst=\(instanceId?.prefix(8) ?? "nil") clearContext=\(clearContext)", tag: "ipc", level: .info)

        case .requestPlanContent(let tabId, let questionId, let planFilePath, let offset, let length):
            log("CMD: requestPlanContent tabId=\(tabId.prefix(8)) qId=\(questionId.prefix(12)) path=\(planFilePath.suffix(30)) offset=\(offset) len=\(length)", tag: "ipc", level: .info)

        // ── Guided Questions ──
        case .questionsPatch(let tabId, let patch):
            log("CMD: questionsPatch tabId=\(tabId.prefix(8)) wf=\(patch.workflowId.prefix(12)) rev=\(patch.expectedRevision)", tag: "questions", level: .debug)
        case .questionsAction(let tabId, let action):
            log("CMD: questionsAction tabId=\(tabId.prefix(8)) wf=\(action.workflowId.prefix(12)) kind=\(action.kind)", tag: "questions", level: .info)
        case .questionsRefresh(let tabId):
            log("CMD: questionsRefresh tabId=\(tabId.prefix(8))", tag: "questions", level: .info)
        }
    }
}
