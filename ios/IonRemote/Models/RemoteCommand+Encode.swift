// @file-size-exception: Worktree wire encoding shares RemoteCommand's existing Codable extension; extracting it requires an Xcode project edit outside this task.
import Foundation

// MARK: - RemoteCommand encoding

extension RemoteCommand {

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case .sync:
            try container.encode(TypeKey.sync, forKey: .type)
        case .createTab(let workingDirectory, let pinToGroupId, let profileId, let extensions, let clientCmdId, let useWorktree, let sourceBranch):
            try container.encode(TypeKey.createTab, forKey: .type)
            try container.encodeIfPresent(workingDirectory, forKey: .workingDirectory)
            // Only emit optional fields when the caller actually supplied them,
            // so the wire payload for the plain "Add tab" flow stays identical
            // to the pre-merge version (helps bisect any future protocol diffs).
            try container.encodeIfPresent(pinToGroupId, forKey: .pinToGroupId)
            try container.encodeIfPresent(profileId, forKey: .profileId)
            try container.encodeIfPresent(extensions, forKey: .extensions)
            try container.encodeIfPresent(clientCmdId, forKey: .clientCmdId)
            try container.encodeIfPresent(useWorktree, forKey: .useWorktree)
            try container.encodeIfPresent(sourceBranch, forKey: .sourceBranch)
        case .closeTab(let tabId):
            try container.encode(TypeKey.closeTab, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .resetTabSession(let tabId):
            try container.encode(TypeKey.resetTabSession, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .resetEngineSession(let tabId, let instanceId):
            try container.encode(TypeKey.resetEngineSession, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)

        case .prompt(let tabId, let text, let origin, let clientMsgId, let attachments, let implementationPhase, let instanceId):
            try container.encode(TypeKey.prompt, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(origin, forKey: .origin)
            try container.encodeIfPresent(clientMsgId, forKey: .clientMsgId)
            try container.encodeIfPresent(attachments, forKey: .attachments)
            try container.encodeIfPresent(implementationPhase, forKey: .implementationPhase)
            // `instanceId` is absent on plain CLI prompts; present when the
            // iOS client is targeting a specific engine instance (merged from
            // the former desktop_engine_prompt command shape, #256).
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
        // ── Worktree + integration bench ──
        case .worktreeRefresh(let repoPath):
            try container.encode(TypeKey.worktreeRefresh, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)

        case .worktreeOpenConversation(let worktreePath, let newConversation):
            try container.encode(TypeKey.worktreeOpenConversation, forKey: .type)
            try container.encode(worktreePath, forKey: .worktreePath)
            try container.encode(newConversation, forKey: .newConversation)

        case .worktreeSync(let worktreePath, let sourceBranch, let repoPath):
            try container.encode(TypeKey.worktreeSync, forKey: .type)
            try container.encode(worktreePath, forKey: .worktreePath)
            try container.encode(sourceBranch, forKey: .sourceBranch)
            try container.encode(repoPath, forKey: .repoPath)

        case .worktreeSyncAll(let repoPath):
            try container.encode(TypeKey.worktreeSyncAll, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)

        case .worktreeLandAndRetire(let repoPath, let worktreePath, let worktreeBranch, let sourceBranch):
            try container.encode(TypeKey.worktreeLandAndRetire, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(worktreePath, forKey: .worktreePath)
            try container.encode(worktreeBranch, forKey: .worktreeBranch)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .benchOpenConversation(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchOpenConversation, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .benchOpenTerminal(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchOpenTerminal, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .benchAssemble(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchAssemble, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .benchUpdateMember(let repoPath, let sourceBranch, let worktreePath):
            try container.encode(TypeKey.benchUpdateMember, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)
            try container.encode(worktreePath, forKey: .worktreePath)

        case .benchUpdateAll(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchUpdateAll, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .worktreeSetStage(let repoPath, let worktreePath, let stage):
            try container.encode(TypeKey.worktreeSetStage, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(worktreePath, forKey: .worktreePath)
            // Explicit null clears the stage, so encodeIfPresent would be
            // wrong: an absent key would read as "no change" on the desktop.
            try container.encode(stage, forKey: .stage)

        case .benchReorderMember(let repoPath, let sourceBranch, let worktreePath, let toIndex):
            try container.encode(TypeKey.benchReorderMember, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)
            try container.encode(worktreePath, forKey: .worktreePath)
            try container.encode(toIndex, forKey: .toIndex)

        case .benchAddMember(let repoPath, let sourceBranch, let worktreePath, let branchName):
            try container.encode(TypeKey.benchAddMember, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)
            try container.encode(worktreePath, forKey: .worktreePath)
            try container.encode(branchName, forKey: .branchName)

        case .benchRemoveMember(let repoPath, let sourceBranch, let worktreePath):
            try container.encode(TypeKey.benchRemoveMember, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)
            try container.encode(worktreePath, forKey: .worktreePath)

        case .worktreeRetireLanded(let repoPath):
            try container.encode(TypeKey.worktreeRetireLanded, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)

        case .worktreeCreate(let repoPath, let sourceBranch):
            try container.encode(TypeKey.worktreeCreate, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .worktreeConvertConversation(let tabId):
            try container.encode(TypeKey.worktreeConvertConversation, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .worktreeRename(let repoPath, let worktreePath, let title):
            try container.encode(TypeKey.worktreeRename, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(worktreePath, forKey: .worktreePath)
            try container.encode(title, forKey: .title)

        case .worktreeReprovision(let repoPath, let worktreePath):
            try container.encode(TypeKey.worktreeReprovision, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(worktreePath, forKey: .worktreePath)

        case .benchRecoverConflict(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchRecoverConflict, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .benchAnalyseVerification(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchAnalyseVerification, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .benchDiscardMemberRecordings(let repoPath, let sourceBranch, let branchNames):
            try container.encode(TypeKey.benchDiscardMemberRecordings, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)
            try container.encode(branchNames, forKey: .branchNames)

        case .benchDiscardAllRecordings(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchDiscardAllRecordings, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .worktreeRetire(let repoPath, let worktreePath, let branchName):
            try container.encode(TypeKey.worktreeRetire, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(worktreePath, forKey: .worktreePath)
            try container.encode(branchName, forKey: .branchName)

        case .worktreeConflictAssist(let repoPath, let worktreePath):
            try container.encode(TypeKey.worktreeConflictAssist, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(worktreePath, forKey: .worktreePath)

        case .benchConflictAssist(let repoPath, let sourceBranch):
            try container.encode(TypeKey.benchConflictAssist, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .worktreePipelineStart(let repoPath, let sourceBranch):
            try container.encode(TypeKey.worktreePipelineStart, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)
            try container.encode(sourceBranch, forKey: .sourceBranch)

        case .worktreePipelineConfirmAi(let repoPath):
            try container.encode(TypeKey.worktreePipelineConfirmAi, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)

        case .worktreePipelineCancel(let repoPath):
            try container.encode(TypeKey.worktreePipelineCancel, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)

        case .worktreePipelineDismiss(let repoPath):
            try container.encode(TypeKey.worktreePipelineDismiss, forKey: .type)
            try container.encode(repoPath, forKey: .repoPath)

        case .cancel(let tabId, let scope):
            try container.encode(TypeKey.cancel, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(scope, forKey: .scope)

        case .abortDispatch(let tabId, let dispatchId):
            try container.encode(TypeKey.abortDispatch, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(dispatchId, forKey: .dispatchId)

        case .stopBackgroundTask(let tabId, let taskId, let requestId):
            try container.encode(TypeKey.stopBackgroundTask, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(taskId, forKey: .taskId)
            try container.encode(requestId, forKey: .requestId)

        case .respondPermission(let tabId, let questionId, let optionId):
            try container.encode(TypeKey.respondPermission, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(questionId, forKey: .questionId)
            try container.encode(optionId, forKey: .optionId)
        case .respondElicitation(let tabId, let requestId, let response, let cancelled, let declined):
            try container.encode(TypeKey.respondElicitation, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(requestId, forKey: .requestId)
            try container.encodeIfPresent(response, forKey: .response)
            try container.encode(cancelled, forKey: .cancelled)
            if declined {
                try container.encode(true, forKey: .declined)
            }
        case .setPermissionMode(let tabId, let mode):
            try container.encode(TypeKey.setPermissionMode, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(mode, forKey: .mode)
        case .setThinkingEffort(let tabId, let effort):
            try container.encode(TypeKey.setThinkingEffort, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(effort, forKey: .effort)
        case .tabSettle(let tabId):
            try container.encode(TypeKey.tabSettle, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .tabDelete(let tabId):
            try container.encode(TypeKey.tabDelete, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .tabUnsettle(let tabId):
            try container.encode(TypeKey.tabUnsettle, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .tabSnooze(let tabId, let untilMs):
            try container.encode(TypeKey.tabSnooze, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(untilMs, forKey: .untilMs)
        case .tabUnsnooze(let tabId):
            try container.encode(TypeKey.tabUnsnooze, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .tabMarkUnread(let tabId):
            try container.encode(TypeKey.tabMarkUnread, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .tabPin(let tabId):
            try container.encode(TypeKey.tabPin, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .tabUnpin(let tabId):
            try container.encode(TypeKey.tabUnpin, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .tabReorderPin(let assignments):
            try container.encode(TypeKey.tabReorderPin, forKey: .type)
            try container.encode(assignments, forKey: .assignments)
        case .tabRegenerateTitle(let tabId):
            try container.encode(TypeKey.tabRegenerateTitle, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .reviewSettledTab(let tabId):
            try container.encode(TypeKey.reviewSettledTab, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
        case .loadConversation(let tabId, let before):
            try container.encode(TypeKey.loadConversation, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(before, forKey: .before)
        case .requestResend(let fromSeq, let toSeq):
            try container.encode(TypeKey.requestResend, forKey: .type)
            try container.encode(fromSeq, forKey: .fromSeq)
            try container.encode(toSeq, forKey: .toSeq)
        case .createTerminalTab(let workingDirectory, let clientCmdId):
            try container.encode(TypeKey.createTerminalTab, forKey: .type)
            try container.encodeIfPresent(workingDirectory, forKey: .workingDirectory)
            try container.encodeIfPresent(clientCmdId, forKey: .clientCmdId)

        case .terminalInput(let tabId, let instanceId, let data):
            try container.encode(TypeKey.terminalInput, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(data, forKey: .data)

        case .terminalResize(let tabId, let instanceId, let cols, let rows):
            try container.encode(TypeKey.terminalResize, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(cols, forKey: .cols)
            try container.encode(rows, forKey: .rows)

        case .terminalAddInstance(let tabId):
            try container.encode(TypeKey.terminalAddInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .terminalRemoveInstance(let tabId, let instanceId):
            try container.encode(TypeKey.terminalRemoveInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)

        case .terminalSelectInstance(let tabId, let instanceId):
            try container.encode(TypeKey.terminalSelectInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)

        case .requestTerminalSnapshot(let tabId):
            try container.encode(TypeKey.requestTerminalSnapshot, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .requestAgentState(let tabId, let instanceId):
            try container.encode(TypeKey.requestAgentState, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)

        case .requestContextBreakdown(let tabId):
            try container.encode(TypeKey.requestContextBreakdown, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .renameTab(let tabId, let customTitle):
            try container.encode(TypeKey.renameTab, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(customTitle, forKey: .customTitle)

        case .renameTerminalInstance(let tabId, let instanceId, let label):
            try container.encode(TypeKey.renameTerminalInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(label, forKey: .label)

        case .forkFromMessage(let tabId, let messageId):
            try container.encode(TypeKey.forkFromMessage, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(messageId, forKey: .messageId)

        case .engineRewind(let tabId, let instanceId, let messageId, let userTurnIndex):
            try container.encode(TypeKey.engineRewind, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(messageId, forKey: .messageId)
            try container.encodeIfPresent(userTurnIndex, forKey: .userTurnIndex)

        case .unpair:
            try container.encode(TypeKey.unpair, forKey: .type)

        case .engineAbort(let tabId, let instanceId):
            try container.encode(TypeKey.engineAbort, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)

        case .engineDialogResponse(let tabId, let dialogId, let value, let instanceId):
            try container.encode(TypeKey.engineDialogResponse, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(dialogId, forKey: .dialogId)
            try container.encode(value, forKey: .value)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)

        // loadEngineConversation case removed in WI-004 / #259. Encode path retired.

        case .loadAgentConversation(let conversationIds):
            try container.encode(TypeKey.loadAgentConversation, forKey: .type)
            try container.encode(conversationIds, forKey: .conversationIds)

        case .setTabGroupMode(let mode):
            try container.encode(TypeKey.setTabGroupMode, forKey: .type)
            try container.encode(mode, forKey: .mode)

        case .moveTabToGroup(let tabId, let groupId):
            try container.encode(TypeKey.moveTabToGroup, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(groupId, forKey: .groupId)

        case .toggleTabGroupPin(let tabId):
            try container.encode(TypeKey.toggleTabGroupPin, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .reorderTabGroups(let orderedIds):
            try container.encode(TypeKey.reorderTabGroups, forKey: .type)
            try container.encode(orderedIds, forKey: .orderedIds)

        case .engineSetModel(let tabId, let model, let instanceId):
            try container.encode(TypeKey.engineSetModel, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(model, forKey: .model)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)

        case .setTabModel(let tabId, let model):
            try container.encode(TypeKey.setTabModel, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(model, forKey: .model)

        case .setPreferredModel(let model):
            try container.encode(TypeKey.setPreferredModel, forKey: .type)
            try container.encode(model, forKey: .model)

        case .setEngineDefaultModel(let model):
            try container.encode(TypeKey.setEngineDefaultModel, forKey: .type)
            try container.encode(model, forKey: .model)

        case .gitChanges(let directory):
            try container.encode(TypeKey.gitChanges, forKey: .type)
            try container.encode(directory, forKey: .directory)

        case .gitBranches(let directory):
            try container.encode(TypeKey.gitBranches, forKey: .type)
            try container.encode(directory, forKey: .directory)

        case .gitGraph(let directory, let skip, let limit):
            try container.encode(TypeKey.gitGraph, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encodeIfPresent(skip, forKey: .skip)
            try container.encodeIfPresent(limit, forKey: .limit)

        case .gitDiff(let directory, let path, let staged):
            try container.encode(TypeKey.gitDiff, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(path, forKey: .path)
            try container.encode(staged, forKey: .staged)

        case .gitStage(let directory, let paths):
            try container.encode(TypeKey.gitStage, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(paths, forKey: .paths)

        case .gitUnstage(let directory, let paths):
            try container.encode(TypeKey.gitUnstage, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(paths, forKey: .paths)

        case .gitCommit(let directory, let message):
            try container.encode(TypeKey.gitCommit, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(message, forKey: .message)

        case .gitDiscard(let directory, let paths):
            try container.encode(TypeKey.gitDiscard, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(paths, forKey: .paths)

        case .gitFetch(let directory):
            try container.encode(TypeKey.gitFetch, forKey: .type)
            try container.encode(directory, forKey: .directory)

        case .gitPull(let directory):
            try container.encode(TypeKey.gitPull, forKey: .type)
            try container.encode(directory, forKey: .directory)

        case .gitPush(let directory):
            try container.encode(TypeKey.gitPush, forKey: .type)
            try container.encode(directory, forKey: .directory)

        case .gitCommitFiles(let directory, let hash):
            try container.encode(TypeKey.gitCommitFiles, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(hash, forKey: .hash)

        case .gitCommitFileDiff(let directory, let hash, let path):
            try container.encode(TypeKey.gitCommitFileDiff, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(hash, forKey: .hash)
            try container.encode(path, forKey: .path)

        case .fsListDir(let directory, let includeHidden):
            try container.encode(TypeKey.fsListDir, forKey: .type)
            try container.encode(directory, forKey: .directory)
            if includeHidden {
                try container.encode(includeHidden, forKey: .includeHidden)
            }

        case .fsReadFile(let filePath):
            try container.encode(TypeKey.fsReadFile, forKey: .type)
            try container.encode(filePath, forKey: .filePath)

        case .fsReadImage(let filePath):
            try container.encode(TypeKey.fsReadImage, forKey: .type)
            try container.encode(filePath, forKey: .filePath)

        case .requestThemeAsset(let themeId, let slot):
            try container.encode(TypeKey.requestThemeAsset, forKey: .type)
            try container.encode(themeId, forKey: .themeId)
            try container.encode(slot, forKey: .slot)

        case .fsWriteFile(let filePath, let content):
            try container.encode(TypeKey.fsWriteFile, forKey: .type)
            try container.encode(filePath, forKey: .filePath)
            try container.encode(content, forKey: .content)

        case .fsRename(let oldPath, let newPath):
            try container.encode(TypeKey.fsRename, forKey: .type)
            try container.encode(oldPath, forKey: .oldPath)
            try container.encode(newPath, forKey: .newPath)

        case .discoverCommands(let directory):
            try container.encode(TypeKey.discoverCommands, forKey: .type)
            try container.encode(directory, forKey: .directory)

        case .uploadAttachment(let dataUrl, let name, let correlationId):
            try container.encode(TypeKey.uploadAttachment, forKey: .type)
            try container.encode(dataUrl, forKey: .dataUrl)
            try container.encode(name, forKey: .name)
            try container.encode(correlationId, forKey: .correlationId)

        case .loadAttachments(let tabId):
            try container.encode(TypeKey.loadAttachments, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .voiceConfig(let enabled, let mode, let systemPrompt):
            try container.encode(TypeKey.voiceConfig, forKey: .type)
            try container.encode(enabled, forKey: .enabled)
            try container.encode(mode, forKey: .mode)
            try container.encodeIfPresent(systemPrompt, forKey: .systemPrompt)

        case .diagnosticLogsResponse(let logs, let pairingId, let nextSeq):
            try container.encode(TypeKey.diagnosticLogsResponse, forKey: .type)
            try container.encode(logs, forKey: .logs)
            try container.encode(pairingId, forKey: .pairingId)
            try container.encode(nextSeq, forKey: .nextSeq)

        case .setRemoteDisplay(let customName, let customIcon, let updatedAt):
            try container.encode(TypeKey.setRemoteDisplay, forKey: .type)
            // Encode `null` explicitly (not "absent") so the desktop can
            // distinguish "clear the override" from "no field provided".
            if let customName {
                try container.encode(customName, forKey: .customName)
            } else {
                try container.encodeNil(forKey: .customName)
            }
            if let customIcon {
                try container.encode(customIcon, forKey: .customIcon)
            } else {
                try container.encodeNil(forKey: .customIcon)
            }
            let updatedAtMs = updatedAt.timeIntervalSince1970 * 1000.0
            try container.encode(updatedAtMs, forKey: .updatedAt)

        case .setDesktopSetting(let key, let value):
            // Write-back for a single projectable desktop setting.
            // `value` is type-erased via AnyCodable so the encoder
            // emits the underlying Bool/String/Number verbatim.
            try container.encode(TypeKey.setDesktopSetting, forKey: .type)
            try container.encode(key, forKey: .key)
            try container.encode(value, forKey: .value)

        case .setPillColor(let tabId, let pillColor):
            try container.encode(TypeKey.setPillColor, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            // Encode null explicitly (not absent) so the desktop can distinguish
            // "reset to default" from "field omitted" — matches the setRemoteDisplay
            // null-encoding pattern.
            if let pillColor {
                try container.encode(pillColor, forKey: .pillColor)
            } else {
                try container.encodeNil(forKey: .pillColor)
            }

        case .setPillIcon(let tabId, let pillIcon):
            try container.encode(TypeKey.setPillIcon, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            if let pillIcon {
                try container.encode(pillIcon, forKey: .pillIcon)
            } else {
                try container.encodeNil(forKey: .pillIcon)
            }

        case .reportFocus(let tabId, let interceptEnabled):
            // Desktop reads `tabId` (nullable) and `interceptEnabled`.
            // Send `tabId: null` when the app is backgrounded so the
            // desktop knows this device is not focused on any tab.
            try container.encode(TypeKey.reportFocus, forKey: .type)
            if let tabId {
                try container.encode(tabId, forKey: .tabId)
            } else {
                try container.encodeNil(forKey: .tabId)
            }
            try container.encode(interceptEnabled, forKey: .interceptEnabled)

        case .reportMobileAuth(let accountUsername, let accountName, let subject, let tenantId, let signedInAt, let clearIdentity, let accessStatus, let accessReason, let reportedAt):
            try container.encode(TypeKey.reportMobileAuth, forKey: .type)
            try container.encodeIfPresent(accountUsername, forKey: .accountUsername)
            try container.encodeIfPresent(accountName, forKey: .accountName)
            try container.encodeIfPresent(subject, forKey: .subject)
            try container.encodeIfPresent(tenantId, forKey: .tenantId)
            try container.encodeIfPresent(signedInAt?.ISO8601Format(), forKey: .signedInAt)
            if clearIdentity { try container.encode(true, forKey: .clearIdentity)
            }
            try container.encodeIfPresent(accessStatus, forKey: .accessStatus)
            try container.encodeIfPresent(accessReason, forKey: .accessReason)
            try container.encodeIfPresent(reportedAt?.ISO8601Format(), forKey: .reportedAt)

        case .requestResourceContent(let kind, let producer, let resourceId):
            // iOS → desktop: fetch the full content for a single resource item.
            // Desktop reads both fields, queries the renderer store, and replies
            // with a `resource_content` event carrying the body.
            try container.encode(TypeKey.requestResourceContent, forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encodeIfPresent(producer, forKey: .producer)
            try container.encode(resourceId, forKey: .resourceId)

        case .markResourceRead(let kind, let producer, let resourceId):
            // iOS → desktop: propagate read state to the source of truth.
            try container.encode(TypeKey.markResourceRead, forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encodeIfPresent(producer, forKey: .producer)
            try container.encode(resourceId, forKey: .resourceId)

        case .deleteResource(let kind, let producer, let resourceId):
            // iOS → desktop: permanently remove a notification from the
            // global resource broker. Desktop publishes a delete delta
            // through the engine so all subscribers remove the item.
            try container.encode(TypeKey.deleteResource, forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encodeIfPresent(producer, forKey: .producer)
            try container.encode(resourceId, forKey: .resourceId)

        case .implementPlan(let tabId, let questionId, let instanceId, let clearContext):
            // iOS → desktop: trigger the implement pipeline for an ExitPlanMode
            // permission entry. No plan body on the wire — desktop resolves the
            // plan from disk and drives the full onImplement pipeline internally.
            // clearContext is omitted when false to keep the wire slim.
            try container.encode(TypeKey.implementPlan, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(questionId, forKey: .questionId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            if clearContext {
                try container.encode(true, forKey: .clearContext)
            }

        case .requestPlanContent(let tabId, let questionId, let planFilePath, let offset, let length):
            // iOS → desktop: request a bounded byte-range window of the plan
            // file. Desktop replies with a plan_content event. length=0 signals
            // "use server default (64 KB)".
            try container.encode(TypeKey.requestPlanContent, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(questionId, forKey: .questionId)
            try container.encode(planFilePath, forKey: .planFilePath)
            try container.encode(offset, forKey: .offset)
            try container.encode(length, forKey: .length)
        }
    }
}
