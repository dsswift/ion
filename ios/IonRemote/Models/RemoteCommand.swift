import Foundation

/// Commands sent from iOS to Ion. Mirrors `RemoteCommand` in `src/main/remote/protocol.ts`.
enum RemoteCommand: Codable, Sendable {
    case sync
    case createTab(workingDirectory: String?)
    case createTerminalTab(workingDirectory: String?)
    case closeTab(tabId: String)
    case prompt(tabId: String, text: String, origin: String? = "remote", clientMsgId: String? = nil, attachments: [CommandAttachment]? = nil)
    case cancel(tabId: String)
    case respondPermission(tabId: String, questionId: String, optionId: String)
    case setPermissionMode(tabId: String, mode: PermissionMode)
    case loadConversation(tabId: String, before: String?)
    case terminalInput(tabId: String, instanceId: String, data: String)
    case terminalResize(tabId: String, instanceId: String, cols: Int, rows: Int)
    case terminalAddInstance(tabId: String)
    case terminalRemoveInstance(tabId: String, instanceId: String)
    case terminalSelectInstance(tabId: String, instanceId: String)
    case requestTerminalSnapshot(tabId: String)
    case renameTab(tabId: String, customTitle: String?)
    case renameTerminalInstance(tabId: String, instanceId: String, label: String)
    case rewind(tabId: String, messageId: String)
    case forkFromMessage(tabId: String, messageId: String)
    case unpair
    case createEngineTab(workingDirectory: String?, profileId: String?)
    case enginePrompt(tabId: String, text: String, instanceId: String? = nil, attachments: [CommandAttachment]? = nil)
    case engineAbort(tabId: String, instanceId: String? = nil)
    case engineDialogResponse(tabId: String, dialogId: String, value: String, instanceId: String? = nil)
    case engineAddInstance(tabId: String)
    case engineRemoveInstance(tabId: String, instanceId: String)
    case engineRenameInstance(tabId: String, instanceId: String, label: String)
    case engineSelectInstance(tabId: String, instanceId: String)
    case loadEngineConversation(tabId: String, instanceId: String?)
    case setTabGroupMode(mode: String)
    case moveTabToGroup(tabId: String, groupId: String)
    case reorderTabGroups(orderedIds: [String])
    case engineSetModel(tabId: String, model: String, instanceId: String? = nil)
    case setTabModel(tabId: String, model: String)
    case setPreferredModel(model: String)
    case setEngineDefaultModel(model: String)
    case gitChanges(directory: String)
    case gitGraph(directory: String, skip: Int? = nil, limit: Int? = nil)
    case gitDiff(directory: String, path: String, staged: Bool)
    case gitStage(directory: String, paths: [String])
    case gitUnstage(directory: String, paths: [String])
    case gitCommit(directory: String, message: String)
    case gitDiscard(directory: String, paths: [String])
    case gitFetch(directory: String)
    case gitPull(directory: String)
    case gitPush(directory: String)
    case gitCommitFiles(directory: String, hash: String)
    case gitCommitFileDiff(directory: String, hash: String, path: String)
    case fsListDir(directory: String, includeHidden: Bool = false)
    case fsReadFile(filePath: String)
    case fsReadImage(filePath: String)
    case fsWriteFile(filePath: String, content: String)
    case discoverCommands(directory: String)
    case uploadAttachment(dataUrl: String, name: String, correlationId: String)
    case loadAttachments(tabId: String)
    case voiceConfig(enabled: Bool, mode: String, systemPrompt: String?)
    case diagnosticLogsResponse(logs: String, deviceId: String, deviceName: String)

    // MARK: - Codable

    enum TypeKey: String, Codable {
        case sync
        case createTab = "create_tab"
        case createTerminalTab = "create_terminal_tab"
        case closeTab = "close_tab"
        case prompt
        case cancel
        case respondPermission = "respond_permission"
        case setPermissionMode = "set_permission_mode"
        case loadConversation = "load_conversation"
        case terminalInput = "terminal_input"
        case terminalResize = "terminal_resize"
        case terminalAddInstance = "terminal_add_instance"
        case terminalRemoveInstance = "terminal_remove_instance"
        case terminalSelectInstance = "terminal_select_instance"
        case requestTerminalSnapshot = "request_terminal_snapshot"
        case renameTab = "rename_tab"
        case renameTerminalInstance = "rename_terminal_instance"
        case rewind
        case forkFromMessage = "fork_from_message"
        case unpair
        case createEngineTab = "create_engine_tab"
        case enginePrompt = "engine_prompt"
        case engineAbort = "engine_abort"
        case engineDialogResponse = "engine_dialog_response"
        case engineAddInstance = "engine_add_instance"
        case engineRemoveInstance = "engine_remove_instance"
        case engineRenameInstance = "engine_rename_instance"
        case engineSelectInstance = "engine_select_instance"
        case loadEngineConversation = "load_engine_conversation"
        case setTabGroupMode = "set_tab_group_mode"
        case moveTabToGroup = "move_tab_to_group"
        case reorderTabGroups = "reorder_tab_groups"
        case engineSetModel = "engine_set_model"
        case setTabModel = "set_tab_model"
        case setPreferredModel = "set_preferred_model"
        case setEngineDefaultModel = "set_engine_default_model"
        case gitChanges = "git_changes"
        case gitGraph = "git_graph"
        case gitDiff = "git_diff"
        case gitStage = "git_stage"
        case gitUnstage = "git_unstage"
        case gitCommit = "git_commit"
        case gitDiscard = "git_discard"
        case gitFetch = "git_fetch"
        case gitPull = "git_pull"
        case gitPush = "git_push"
        case gitCommitFiles = "git_commit_files"
        case gitCommitFileDiff = "git_commit_file_diff"
        case fsListDir = "fs_list_dir"
        case fsReadFile = "fs_read_file"
        case fsReadImage = "fs_read_image"
        case fsWriteFile = "fs_write_file"
        case discoverCommands = "discover_commands"
        case uploadAttachment = "upload_attachment"
        case loadAttachments = "load_attachments"
        case voiceConfig = "voice_config"
        case diagnosticLogsResponse = "diagnostic_logs_response"
    }

    enum CodingKeys: String, CodingKey {
        case type
        case workingDirectory, tabId, text, questionId, optionId, mode, before, origin
        case instanceId, data, cols, rows, customTitle, label, messageId, clientMsgId
        case dialogId, value, profileId, model, groupId
        case directory, path, staged, paths, skip, limit, message, filePath, content, includeHidden, hash
        case attachments, dataUrl, name, correlationId, orderedIds
        case enabled, systemPrompt
        case logs, deviceId, deviceName
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(TypeKey.self, forKey: .type)

        switch type {
        case .sync:
            self = .sync

        case .createTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            self = .createTab(workingDirectory: workingDirectory)

        case .closeTab:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .closeTab(tabId: tabId)

        case .prompt:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let origin = try container.decodeIfPresent(String.self, forKey: .origin)
            let clientMsgId = try container.decodeIfPresent(String.self, forKey: .clientMsgId)
            let attachments = try container.decodeIfPresent([CommandAttachment].self, forKey: .attachments)
            self = .prompt(tabId: tabId, text: text, origin: origin, clientMsgId: clientMsgId, attachments: attachments)

        case .cancel:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .cancel(tabId: tabId)

        case .respondPermission:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            let optionId = try container.decode(String.self, forKey: .optionId)
            self = .respondPermission(tabId: tabId, questionId: questionId, optionId: optionId)

        case .setPermissionMode:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let mode = try container.decode(PermissionMode.self, forKey: .mode)
            self = .setPermissionMode(tabId: tabId, mode: mode)

        case .loadConversation:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let before = try container.decodeIfPresent(String.self, forKey: .before)
            self = .loadConversation(tabId: tabId, before: before)

        case .createTerminalTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            self = .createTerminalTab(workingDirectory: workingDirectory)

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

        case .unpair:
            self = .unpair

        case .createEngineTab:
            let workingDirectory = try container.decodeIfPresent(String.self, forKey: .workingDirectory)
            let profileId = try container.decodeIfPresent(String.self, forKey: .profileId)
            self = .createEngineTab(workingDirectory: workingDirectory, profileId: profileId)

        case .enginePrompt:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let attachments = try container.decodeIfPresent([CommandAttachment].self, forKey: .attachments)
            self = .enginePrompt(tabId: tabId, text: text, instanceId: instanceId, attachments: attachments)

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

        case .engineAddInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .engineAddInstance(tabId: tabId)

        case .engineRemoveInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .engineRemoveInstance(tabId: tabId, instanceId: instanceId)

        case .engineRenameInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let label = try container.decode(String.self, forKey: .label)
            self = .engineRenameInstance(tabId: tabId, instanceId: instanceId, label: label)

        case .engineSelectInstance:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .engineSelectInstance(tabId: tabId, instanceId: instanceId)

        case .loadEngineConversation:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            self = .loadEngineConversation(tabId: tabId, instanceId: instanceId)

        case .setTabGroupMode:
            let mode = try container.decode(String.self, forKey: .mode)
            self = .setTabGroupMode(mode: mode)

        case .moveTabToGroup:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let groupId = try container.decode(String.self, forKey: .groupId)
            self = .moveTabToGroup(tabId: tabId, groupId: groupId)

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
        }
    }

}

/// Attachment metadata sent with prompt and engine_prompt commands.
struct CommandAttachment: Codable, Sendable {
    let type: String   // "image" or "file"
    let name: String
    let path: String
}
