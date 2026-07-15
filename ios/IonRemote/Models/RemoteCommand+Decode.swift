import Foundation

// MARK: - Decodable conformance

// Extracted from RemoteCommand.swift to keep that file under the 600-line
// Swift cap. The encode counterpart lives in RemoteCommand+Encode.swift.
// All three files (RemoteCommand.swift, RemoteCommand+Decode.swift,
// RemoteCommand+Encode.swift) form the full Codable conformance for the
// RemoteCommand enum.

extension RemoteCommand {

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(TypeKey.self, forKey: .type)

        switch type {
        case .sync:
            self = .sync

        case .createTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            // Decode the optional extensions added in #256 (engine-tab creation).
            // Older desktops that don't emit these fields decode nil; behavior
            // degrades to the legacy plain-tab path. The round-trip test
            // exercises both fields flowing through encode → decode.
            let pinToGroupId = try container.decodeIfPresent(String.self, forKey: .pinToGroupId)
            let profileId = try container.decodeIfPresent(String.self, forKey: .profileId)
            let extensions = try container.decodeIfPresent([String].self, forKey: .extensions)
            let clientCmdId = try container.decodeIfPresent(String.self, forKey: .clientCmdId)
            self = .createTab(workingDirectory: workingDirectory, pinToGroupId: pinToGroupId, profileId: profileId, extensions: extensions, clientCmdId: clientCmdId)

        case .closeTab:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .closeTab(tabId: tabId)

        case .resetTabSession:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .resetTabSession(tabId: tabId)

        case .resetEngineSession:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .resetEngineSession(tabId: tabId, instanceId: instanceId)

        case .prompt:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let origin = try container.decodeIfPresent(String.self, forKey: .origin)
            let clientMsgId = try container.decodeIfPresent(String.self, forKey: .clientMsgId)
            let attachments = try container.decodeIfPresent([CommandAttachment].self, forKey: .attachments)
            let implementationPhase = try container.decodeIfPresent(Bool.self, forKey: .implementationPhase)
            // `instanceId` is absent on plain CLI prompts; present when the
            // command targets a specific engine instance (merged from the former
            // desktop_engine_prompt shape, #256).
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .prompt(tabId: tabId, text: text, origin: origin, clientMsgId: clientMsgId, attachments: attachments, implementationPhase: implementationPhase, instanceId: instanceId)

        case .cancel:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .cancel(tabId: tabId)

        case .respondPermission:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            let optionId = try container.decode(String.self, forKey: .optionId)
            self = .respondPermission(tabId: tabId, questionId: questionId, optionId: optionId)

        case .respondElicitation:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let requestId = try container.decode(String.self, forKey: .requestId)
            let response = try container.decodeIfPresent([String: AnyCodable].self, forKey: .response)
            let cancelled = try container.decode(Bool.self, forKey: .cancelled)
            self = .respondElicitation(tabId: tabId, requestId: requestId, response: response, cancelled: cancelled)

        case .setPermissionMode:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let mode = try container.decode(PermissionMode.self, forKey: .mode)
            self = .setPermissionMode(tabId: tabId, mode: mode)

        case .setThinkingEffort:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let effort = try container.decode(String.self, forKey: .effort)
            self = .setThinkingEffort(tabId: tabId, effort: effort)

        case .loadConversation:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let before = try container.decodeIfPresent(String.self, forKey: .before)
            self = .loadConversation(tabId: tabId, before: before)

        case .requestResend:
            // iOS only ever ENCODES this (it asks the desktop to resend); the
            // decode case exists to keep the TypeKey switch exhaustive and for
            // round-trip test coverage.
            let fromSeq = try container.decode(UInt64.self, forKey: .fromSeq)
            let toSeq = try container.decode(UInt64.self, forKey: .toSeq)
            self = .requestResend(fromSeq: fromSeq, toSeq: toSeq)

        case .createTerminalTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            let clientCmdId = try container.decodeIfPresent(String.self, forKey: .clientCmdId)
            self = .createTerminalTab(workingDirectory: workingDirectory, clientCmdId: clientCmdId)

        case .terminalInput:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let data = try container.decode(String.self, forKey: .data)
            self = .terminalInput(tabId: tabId, instanceId: instanceId, data: data)

        case .terminalResize:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let cols = try container.decode(Int.self, forKey: .cols)
            let rows = try container.decode(Int.self, forKey: .rows)
            self = .terminalResize(tabId: tabId, instanceId: instanceId, cols: cols, rows: rows)

        case .terminalAddInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .terminalAddInstance(tabId: tabId)

        case .terminalRemoveInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .terminalRemoveInstance(tabId: tabId, instanceId: instanceId)

        case .terminalSelectInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .terminalSelectInstance(tabId: tabId, instanceId: instanceId)

        case .requestTerminalSnapshot:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .requestTerminalSnapshot(tabId: tabId)

        case .requestContextBreakdown:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .requestContextBreakdown(tabId: tabId)

        case .renameTab:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let customTitle = try container.decodeIfPresent(String.self, forKey: .customTitle)
            self = .renameTab(tabId: tabId, customTitle: customTitle)

        case .renameTerminalInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let label = try container.decode(String.self, forKey: .label)
            self = .renameTerminalInstance(tabId: tabId, instanceId: instanceId, label: label)

        case .rewind:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            self = .rewind(tabId: tabId, messageId: messageId)

        case .forkFromMessage:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            self = .forkFromMessage(tabId: tabId, messageId: messageId)

        case .engineRewind:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            let userTurnIndex = try container.decodeIfPresent(Int.self, forKey: .userTurnIndex)
            self = .engineRewind(tabId: tabId, instanceId: instanceId, messageId: messageId, userTurnIndex: userTurnIndex)

        case .unpair:
            self = .unpair

        case .engineAbort:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .engineAbort(tabId: tabId, instanceId: instanceId)

        case .engineDialogResponse:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            let value = try container.decode(String.self, forKey: .value)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .engineDialogResponse(tabId: tabId, dialogId: dialogId, value: value, instanceId: instanceId)

        // .loadEngineConversation decode case removed in WI-004 / #259.

        case .loadAgentConversation:
            let conversationIds = try container.decode([String].self, forKey: .conversationIds)
            self = .loadAgentConversation(conversationIds: conversationIds)

        case .setTabGroupMode:
            let mode = try container.decode(String.self, forKey: .mode)
            self = .setTabGroupMode(mode: mode)

        case .moveTabToGroup:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let groupId = try container.decode(String.self, forKey: .groupId)
            self = .moveTabToGroup(tabId: tabId, groupId: groupId)

        case .toggleTabGroupPin:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .toggleTabGroupPin(tabId: tabId)

        case .reorderTabGroups:
            let orderedIds = try container.decode([String].self, forKey: .orderedIds)
            self = .reorderTabGroups(orderedIds: orderedIds)

        case .engineSetModel:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let model = try container.decode(String.self, forKey: .model)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .engineSetModel(tabId: tabId, model: model, instanceId: instanceId)

        case .setTabModel:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let model = try container.decode(String.self, forKey: .model)
            self = .setTabModel(tabId: tabId, model: model)

        case .setPreferredModel:
            let model = try container.decode(String.self, forKey: .model)
            self = .setPreferredModel(model: model)

        case .setEngineDefaultModel:
            let model = try container.decode(String.self, forKey: .model)
            self = .setEngineDefaultModel(model: model)

        case .gitChanges:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitChanges(directory: directory)

        case .gitGraph:
            let directory = try container.decode(String.self, forKey: .directory)
            let skip = try container.decodeIfPresent(Int.self, forKey: .skip)
            let limit = try container.decodeIfPresent(Int.self, forKey: .limit)
            self = .gitGraph(directory: directory, skip: skip, limit: limit)

        case .gitDiff:
            let directory = try container.decode(String.self, forKey: .directory)
            let path = try container.decode(String.self, forKey: .path)
            let staged = try container.decode(Bool.self, forKey: .staged)
            self = .gitDiff(directory: directory, path: path, staged: staged)

        case .gitStage:
            let directory = try container.decode(String.self, forKey: .directory)
            let paths = try container.decode([String].self, forKey: .paths)
            self = .gitStage(directory: directory, paths: paths)

        case .gitUnstage:
            let directory = try container.decode(String.self, forKey: .directory)
            let paths = try container.decode([String].self, forKey: .paths)
            self = .gitUnstage(directory: directory, paths: paths)

        case .gitCommit:
            let directory = try container.decode(String.self, forKey: .directory)
            let message = try container.decode(String.self, forKey: .message)
            self = .gitCommit(directory: directory, message: message)

        case .gitDiscard:
            let directory = try container.decode(String.self, forKey: .directory)
            let paths = try container.decode([String].self, forKey: .paths)
            self = .gitDiscard(directory: directory, paths: paths)

        case .gitFetch:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitFetch(directory: directory)

        case .gitPull:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitPull(directory: directory)

        case .gitPush:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .gitPush(directory: directory)

        case .gitCommitFiles:
            let directory = try container.decode(String.self, forKey: .directory)
            let hash = try container.decode(String.self, forKey: .hash)
            self = .gitCommitFiles(directory: directory, hash: hash)

        case .gitCommitFileDiff:
            let directory = try container.decode(String.self, forKey: .directory)
            let hash = try container.decode(String.self, forKey: .hash)
            let path = try container.decode(String.self, forKey: .path)
            self = .gitCommitFileDiff(directory: directory, hash: hash, path: path)

        case .fsListDir:
            let directory = try container.decode(String.self, forKey: .directory)
            let includeHidden = try container.decodeIfPresent(Bool.self, forKey: .includeHidden) ?? false
            self = .fsListDir(directory: directory, includeHidden: includeHidden)

        case .fsReadFile:
            let filePath = try container.decode(String.self, forKey: .filePath)
            self = .fsReadFile(filePath: filePath)

        case .fsReadImage:
            let filePath = try container.decode(String.self, forKey: .filePath)
            self = .fsReadImage(filePath: filePath)

        case .fsWriteFile:
            let filePath = try container.decode(String.self, forKey: .filePath)
            let content = try container.decode(String.self, forKey: .content)
            self = .fsWriteFile(filePath: filePath, content: content)

        case .fsRename:
            let oldPath = try container.decode(String.self, forKey: .oldPath)
            let newPath = try container.decode(String.self, forKey: .newPath)
            self = .fsRename(oldPath: oldPath, newPath: newPath)

        case .discoverCommands:
            let directory = try container.decode(String.self, forKey: .directory)
            self = .discoverCommands(directory: directory)

        case .uploadAttachment:
            let dataUrl = try container.decode(String.self, forKey: .dataUrl)
            let name = try container.decode(String.self, forKey: .name)
            let correlationId = try container.decode(String.self, forKey: .correlationId)
            self = .uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)

        case .loadAttachments:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .loadAttachments(tabId: tabId)

        case .voiceConfig:
            let enabled = try container.decode(Bool.self, forKey: .enabled)
            let mode = try container.decode(String.self, forKey: .mode)
            let systemPrompt = try container.decodeIfPresent(String.self, forKey: .systemPrompt)
            self = .voiceConfig(enabled: enabled, mode: mode, systemPrompt: systemPrompt)

        case .diagnosticLogsResponse:
            let logs = try container.decode(String.self, forKey: .logs)
            let deviceId = try container.decode(String.self, forKey: .deviceId)
            let deviceName = try container.decode(String.self, forKey: .deviceName)
            self = .diagnosticLogsResponse(logs: logs, deviceId: deviceId, deviceName: deviceName)

        case .setRemoteDisplay:
            // Both fields are nullable on the wire; treat absent OR explicit
            // null identically so old desktops can omit them.
            let customName = try container.decodeIfPresent(String.self, forKey: .customName)
            let customIcon = try container.decodeIfPresent(String.self, forKey: .customIcon)
            let updatedAtMs = try container.decode(Double.self, forKey: .updatedAt)
            self = .setRemoteDisplay(
                customName: customName,
                customIcon: customIcon,
                updatedAt: Date(timeIntervalSince1970: updatedAtMs / 1000.0),
            )

        case .setDesktopSetting:
            // Round-trip decode for tests + diagnostic dumps. iOS
            // typically only encodes this command (never decodes it
            // from the wire), but the Codable conformance requires
            // the path to exist.
            let key = try container.decode(String.self, forKey: .key)
            let value = try container.decode(AnyCodable.self, forKey: .value)
            self = .setDesktopSetting(key: key, value: value)

        case .setPillColor:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let pillColor = try container.decodeIfPresent(String.self, forKey: .pillColor)
            self = .setPillColor(tabId: tabId, pillColor: pillColor)

        case .setPillIcon:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let pillIcon = try container.decodeIfPresent(String.self, forKey: .pillIcon)
            self = .setPillIcon(tabId: tabId, pillIcon: pillIcon)

        case .reportFocus:
            // iOS never decodes this from the wire (it only sends it),
            // but the conformance requires the path. Default interceptEnabled
            // to true so a round-trip decode-then-encode produces a safe value.
            let tabId = try container.decodeIfPresent(String.self, forKey: .tabId)
            let interceptEnabled = try container.decodeIfPresent(Bool.self, forKey: .interceptEnabled) ?? true
            self = .reportFocus(tabId: tabId, interceptEnabled: interceptEnabled)

        case .requestResourceContent:
            // iOS only sends this command (never decodes it from the wire),
            // but the Codable conformance requires the path.
            let kind = try container.decode(String.self, forKey: .kind)
            let resourceId = try container.decode(String.self, forKey: .resourceId)
            self = .requestResourceContent(kind: kind, resourceId: resourceId)

        case .markResourceRead:
            // iOS only sends this command (never decodes it from the wire),
            // but the Codable conformance requires the path.
            let kind = try container.decode(String.self, forKey: .kind)
            let resourceId = try container.decode(String.self, forKey: .resourceId)
            self = .markResourceRead(kind: kind, resourceId: resourceId)

        case .deleteResource:
            // iOS only sends this command (never decodes it from the wire),
            // but the Codable conformance requires the path.
            let kind = try container.decode(String.self, forKey: .kind)
            let resourceId = try container.decode(String.self, forKey: .resourceId)
            self = .deleteResource(kind: kind, resourceId: resourceId)

        case .implementPlan:
            // iOS only sends this command (never decodes it from the wire),
            // but the Codable conformance requires the path.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let clearContext = try container.decodeIfPresent(Bool.self, forKey: .clearContext) ?? false
            self = .implementPlan(tabId: tabId, questionId: questionId, instanceId: instanceId, clearContext: clearContext)

        case .requestPlanContent:
            // iOS only sends this command (never decodes it from the wire),
            // but the Codable conformance requires the path.
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            let planFilePath = try container.decode(String.self, forKey: .planFilePath)
            let offset = try container.decode(Int.self, forKey: .offset)
            let length = try container.decode(Int.self, forKey: .length)
            self = .requestPlanContent(tabId: tabId, questionId: questionId, planFilePath: planFilePath, offset: offset, length: length)
        }
    }

}
