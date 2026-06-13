import Foundation

// MARK: - RemoteCommand encoding

extension RemoteCommand {

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case .sync:
            try container.encode(TypeKey.sync, forKey: .type)
        case .createTab(let workingDirectory, let pinToGroupId):
            try container.encode(TypeKey.createTab, forKey: .type)
            try container.encodeIfPresent(workingDirectory, forKey: .workingDirectory)
            // Only emit `pinToGroupId` when caller actually requested a pin,
            // so the wire payload for the unmodified "Add tab" flow stays
            // identical to the pre-feature version (helps when bisecting
            // any future protocol-level diffs).
            try container.encodeIfPresent(pinToGroupId, forKey: .pinToGroupId)
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

        case .prompt(let tabId, let text, let origin, let clientMsgId, let attachments, let implementationPhase):
            try container.encode(TypeKey.prompt, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(origin, forKey: .origin)
            try container.encodeIfPresent(clientMsgId, forKey: .clientMsgId)
            try container.encodeIfPresent(attachments, forKey: .attachments)
            try container.encodeIfPresent(implementationPhase, forKey: .implementationPhase)
        case .cancel(let tabId):
            try container.encode(TypeKey.cancel, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .respondPermission(let tabId, let questionId, let optionId):
            try container.encode(TypeKey.respondPermission, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(questionId, forKey: .questionId)
            try container.encode(optionId, forKey: .optionId)
        case .setPermissionMode(let tabId, let mode):
            try container.encode(TypeKey.setPermissionMode, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(mode, forKey: .mode)
        case .loadConversation(let tabId, let before):
            try container.encode(TypeKey.loadConversation, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(before, forKey: .before)
        case .createTerminalTab(let workingDirectory):
            try container.encode(TypeKey.createTerminalTab, forKey: .type)
            try container.encodeIfPresent(workingDirectory, forKey: .workingDirectory)

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

        case .renameTab(let tabId, let customTitle):
            try container.encode(TypeKey.renameTab, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(customTitle, forKey: .customTitle)

        case .renameTerminalInstance(let tabId, let instanceId, let label):
            try container.encode(TypeKey.renameTerminalInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(label, forKey: .label)

        case .rewind(let tabId, let messageId):
            try container.encode(TypeKey.rewind, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(messageId, forKey: .messageId)

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

        case .createEngineTab(let workingDirectory, let profileId):
            try container.encode(TypeKey.createEngineTab, forKey: .type)
            try container.encodeIfPresent(workingDirectory, forKey: .workingDirectory)
            try container.encodeIfPresent(profileId, forKey: .profileId)

        case .enginePrompt(let tabId, let text, let instanceId, let attachments, let implementationPhase):
            try container.encode(TypeKey.enginePrompt, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encodeIfPresent(attachments, forKey: .attachments)
            try container.encodeIfPresent(implementationPhase, forKey: .implementationPhase)

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

        case .engineAddInstance(let tabId):
            try container.encode(TypeKey.engineAddInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .engineRemoveInstance(let tabId, let instanceId):
            try container.encode(TypeKey.engineRemoveInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)

        case .engineRenameInstance(let tabId, let instanceId, let label):
            try container.encode(TypeKey.engineRenameInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(label, forKey: .label)

        case .engineSelectInstance(let tabId, let instanceId):
            try container.encode(TypeKey.engineSelectInstance, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)

        case .engineMoveInstance(let sourceTabId, let instanceId, let targetTabId):
            try container.encode(TypeKey.engineMoveInstance, forKey: .type)
            try container.encode(sourceTabId, forKey: .sourceTabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(targetTabId, forKey: .targetTabId)

        case .loadEngineConversation(let tabId, let instanceId):
            try container.encode(TypeKey.loadEngineConversation, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)

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

        case .diagnosticLogsResponse(let logs, let deviceId, let deviceName):
            try container.encode(TypeKey.diagnosticLogsResponse, forKey: .type)
            try container.encode(logs, forKey: .logs)
            try container.encode(deviceId, forKey: .deviceId)
            try container.encode(deviceName, forKey: .deviceName)

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

        case .requestResourceContent(let kind, let resourceId):
            // iOS → desktop: fetch the full content for a single resource item.
            // Desktop reads both fields, queries the renderer store, and replies
            // with a `resource_content` event carrying the body.
            try container.encode(TypeKey.requestResourceContent, forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encode(resourceId, forKey: .resourceId)

        case .markResourceRead(let kind, let resourceId):
            // iOS → desktop: propagate read state to the source of truth.
            try container.encode(TypeKey.markResourceRead, forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encode(resourceId, forKey: .resourceId)

        case .deleteResource(let kind, let resourceId):
            // iOS → desktop: permanently remove a notification from the
            // global resource broker. Desktop publishes a delete delta
            // through the engine so all subscribers remove the item.
            try container.encode(TypeKey.deleteResource, forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encode(resourceId, forKey: .resourceId)
        }
    }
}
