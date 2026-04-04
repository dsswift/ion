import Foundation

/// Commands sent from iOS to CODA.
/// Mirrors `RemoteCommand` in `src/main/remote/protocol.ts`.
enum RemoteCommand: Codable, Sendable {
    case sync
    case createTab(workingDirectory: String?)
    case createTerminalTab(workingDirectory: String?)
    case closeTab(tabId: String)
    case prompt(tabId: String, text: String, origin: String? = "remote")
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

    // MARK: - Codable

    private enum TypeKey: String, Codable {
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
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case workingDirectory, tabId, text, questionId, optionId, mode, before, origin
        case instanceId, data, cols, rows, customTitle, label, messageId
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
            self = .prompt(tabId: tabId, text: text, origin: origin)

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
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case .sync:
            try container.encode(TypeKey.sync, forKey: .type)

        case .createTab(let workingDirectory):
            try container.encode(TypeKey.createTab, forKey: .type)
            try container.encodeIfPresent(workingDirectory, forKey: .workingDirectory)

        case .closeTab(let tabId):
            try container.encode(TypeKey.closeTab, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .prompt(let tabId, let text, let origin):
            try container.encode(TypeKey.prompt, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(origin, forKey: .origin)

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

        case .unpair:
            try container.encode(TypeKey.unpair, forKey: .type)
        }
    }
}
