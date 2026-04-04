import Foundation

/// Events sent from CODA to the iOS app.
/// Mirrors `RemoteEvent` in `src/main/remote/protocol.ts`.
enum RemoteEvent: Codable, Sendable {
    case snapshot(tabs: [RemoteTabState], recentDirectories: [String])
    case tabCreated(tab: RemoteTabState)
    case tabClosed(tabId: String)
    case tabStatus(tabId: String, status: TabStatus)
    case textChunk(tabId: String, text: String)
    case toolCall(tabId: String, toolName: String, toolId: String)
    case toolResult(tabId: String, toolId: String, content: String, isError: Bool)
    case taskComplete(tabId: String, result: String, costUsd: Double)
    case permissionRequest(tabId: String, questionId: String, toolName: String, toolInput: [String: AnyCodable]?, options: [PermissionOption])
    case permissionResolved(tabId: String, questionId: String)
    case conversationHistory(tabId: String, messages: [Message], hasMore: Bool, cursor: String?)
    case messageAdded(tabId: String, message: Message)
    case messageUpdated(tabId: String, messageId: String, content: String?, toolStatus: ToolStatus?, toolInput: String?)
    case queueUpdate(tabId: String, prompts: [String])
    case error(tabId: String, message: String)
    /// Desktop revoked this device's pairing -- clear local state.
    case unpair
    /// Desktop pushed updated relay configuration.
    case relayConfig(relayUrl: String, relayApiKey: String)
    /// Synthesized by TransportManager when the desktop peer disconnects.
    case peerDisconnected
    /// Synthesized by TransportManager during the disconnect grace period
    /// (transports dropped but may recover within 4s).
    case transportReconnecting
    /// Desktop is prefilling input text (after rewind or fork).
    case inputPrefill(tabId: String, text: String, switchTo: Bool)
    // Terminal events
    case terminalOutput(tabId: String, instanceId: String, data: String)
    case terminalExit(tabId: String, instanceId: String, exitCode: Int)
    case terminalInstanceAdded(tabId: String, instance: TerminalInstanceInfo)
    case terminalInstanceRemoved(tabId: String, instanceId: String)
    case terminalSnapshot(tabId: String, instances: [TerminalInstanceInfo], activeInstanceId: String?, buffers: [String: String]?)

    // MARK: - Codable

    private enum TypeKey: String, Codable {
        case snapshot
        case tabCreated = "tab_created"
        case tabClosed = "tab_closed"
        case tabStatus = "tab_status"
        case textChunk = "text_chunk"
        case toolCall = "tool_call"
        case toolResult = "tool_result"
        case taskComplete = "task_complete"
        case permissionRequest = "permission_request"
        case permissionResolved = "permission_resolved"
        case conversationHistory = "conversation_history"
        case messageAdded = "message_added"
        case messageUpdated = "message_updated"
        case queueUpdate = "queue_update"
        case unpair
        case relayConfig = "relay_config"
        case peerDisconnected = "peer_disconnected"
        case transportReconnecting = "transport_reconnecting"
        case heartbeat
        case error
        case inputPrefill = "input_prefill"
        case terminalOutput = "terminal_output"
        case terminalExit = "terminal_exit"
        case terminalInstanceAdded = "terminal_instance_added"
        case terminalInstanceRemoved = "terminal_instance_removed"
        case terminalSnapshot = "terminal_snapshot"
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case tabs, tab, tabId, status, text, toolName, toolId
        case content, isError, result, costUsd
        case questionId, toolInput, options, message
        case messages, hasMore, cursor, messageId, prompts, relayUrl, relayApiKey
        case toolStatus, source, recentDirectories
        case switchTo
        case instanceId, data, exitCode, instance, instances, activeInstanceId, buffers
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(TypeKey.self, forKey: .type)

        switch type {
        case .snapshot:
            let tabs = try container.decode([RemoteTabState].self, forKey: .tabs)
            let recentDirs = try container.decodeIfPresent([String].self, forKey: .recentDirectories) ?? []
            self = .snapshot(tabs: tabs, recentDirectories: recentDirs)

        case .tabCreated:
            let tab = try container.decode(RemoteTabState.self, forKey: .tab)
            self = .tabCreated(tab: tab)

        case .tabClosed:
            let tabId = try container.decode(String.self, forKey: .tabId)
            self = .tabClosed(tabId: tabId)

        case .tabStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let status = try container.decode(TabStatus.self, forKey: .status)
            self = .tabStatus(tabId: tabId, status: status)

        case .textChunk:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            self = .textChunk(tabId: tabId, text: text)

        case .toolCall:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let toolId = try container.decode(String.self, forKey: .toolId)
            self = .toolCall(tabId: tabId, toolName: toolName, toolId: toolId)

        case .toolResult:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let content = try container.decode(String.self, forKey: .content)
            let isError = try container.decode(Bool.self, forKey: .isError)
            self = .toolResult(tabId: tabId, toolId: toolId, content: content, isError: isError)

        case .taskComplete:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let result = try container.decode(String.self, forKey: .result)
            let costUsd = try container.decode(Double.self, forKey: .costUsd)
            self = .taskComplete(tabId: tabId, result: result, costUsd: costUsd)

        case .permissionRequest:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let toolInput = try container.decodeIfPresent([String: AnyCodable].self, forKey: .toolInput)
            let options = try container.decode([PermissionOption].self, forKey: .options)
            self = .permissionRequest(tabId: tabId, questionId: questionId, toolName: toolName, toolInput: toolInput, options: options)

        case .permissionResolved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let questionId = try container.decode(String.self, forKey: .questionId)
            self = .permissionResolved(tabId: tabId, questionId: questionId)

        case .conversationHistory:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messages = try container.decode([Message].self, forKey: .messages)
            let hasMore = try container.decode(Bool.self, forKey: .hasMore)
            let cursor = try container.decodeIfPresent(String.self, forKey: .cursor)
            self = .conversationHistory(tabId: tabId, messages: messages, hasMore: hasMore, cursor: cursor)

        case .messageAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let message = try container.decode(Message.self, forKey: .message)
            self = .messageAdded(tabId: tabId, message: message)

        case .messageUpdated:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            let content = try container.decodeIfPresent(String.self, forKey: .content)
            let toolStatus = try container.decodeIfPresent(ToolStatus.self, forKey: .toolStatus)
            let toolInput = try container.decodeIfPresent(String.self, forKey: .toolInput)
            self = .messageUpdated(tabId: tabId, messageId: messageId, content: content, toolStatus: toolStatus, toolInput: toolInput)

        case .queueUpdate:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let prompts = try container.decode([String].self, forKey: .prompts)
            self = .queueUpdate(tabId: tabId, prompts: prompts)

        case .unpair:
            self = .unpair

        case .relayConfig:
            let relayUrl = try container.decode(String.self, forKey: .relayUrl)
            let relayApiKey = try container.decode(String.self, forKey: .relayApiKey)
            self = .relayConfig(relayUrl: relayUrl, relayApiKey: relayApiKey)

        case .peerDisconnected:
            self = .peerDisconnected

        case .transportReconnecting:
            self = .transportReconnecting

        case .heartbeat:
            // Silently absorbed; should not normally reach the decoder.
            self = .error(tabId: "", message: "")

        case .error:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let message = try container.decode(String.self, forKey: .message)
            self = .error(tabId: tabId, message: message)

        case .inputPrefill:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let text = try container.decode(String.self, forKey: .text)
            let switchTo = try container.decodeIfPresent(Bool.self, forKey: .switchTo) ?? false
            self = .inputPrefill(tabId: tabId, text: text, switchTo: switchTo)

        case .terminalOutput:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let data = try container.decode(String.self, forKey: .data)
            self = .terminalOutput(tabId: tabId, instanceId: instanceId, data: data)

        case .terminalExit:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            let exitCode = try container.decode(Int.self, forKey: .exitCode)
            self = .terminalExit(tabId: tabId, instanceId: instanceId, exitCode: exitCode)

        case .terminalInstanceAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instance = try container.decode(TerminalInstanceInfo.self, forKey: .instance)
            self = .terminalInstanceAdded(tabId: tabId, instance: instance)

        case .terminalInstanceRemoved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .terminalInstanceRemoved(tabId: tabId, instanceId: instanceId)

        case .terminalSnapshot:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instances = try container.decode([TerminalInstanceInfo].self, forKey: .instances)
            let activeInstanceId = try container.decodeIfPresent(String.self, forKey: .activeInstanceId)
            let buffers = try container.decodeIfPresent([String: String].self, forKey: .buffers)
            self = .terminalSnapshot(tabId: tabId, instances: instances, activeInstanceId: activeInstanceId, buffers: buffers)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case .snapshot(let tabs, let recentDirectories):
            try container.encode(TypeKey.snapshot, forKey: .type)
            try container.encode(tabs, forKey: .tabs)
            if !recentDirectories.isEmpty {
                try container.encode(recentDirectories, forKey: .recentDirectories)
            }

        case .tabCreated(let tab):
            try container.encode(TypeKey.tabCreated, forKey: .type)
            try container.encode(tab, forKey: .tab)

        case .tabClosed(let tabId):
            try container.encode(TypeKey.tabClosed, forKey: .type)
            try container.encode(tabId, forKey: .tabId)

        case .tabStatus(let tabId, let status):
            try container.encode(TypeKey.tabStatus, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(status, forKey: .status)

        case .textChunk(let tabId, let text):
            try container.encode(TypeKey.textChunk, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)

        case .toolCall(let tabId, let toolName, let toolId):
            try container.encode(TypeKey.toolCall, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(toolId, forKey: .toolId)

        case .toolResult(let tabId, let toolId, let content, let isError):
            try container.encode(TypeKey.toolResult, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(toolId, forKey: .toolId)
            try container.encode(content, forKey: .content)
            try container.encode(isError, forKey: .isError)

        case .taskComplete(let tabId, let result, let costUsd):
            try container.encode(TypeKey.taskComplete, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(result, forKey: .result)
            try container.encode(costUsd, forKey: .costUsd)

        case .permissionRequest(let tabId, let questionId, let toolName, let toolInput, let options):
            try container.encode(TypeKey.permissionRequest, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(questionId, forKey: .questionId)
            try container.encode(toolName, forKey: .toolName)
            try container.encodeIfPresent(toolInput, forKey: .toolInput)
            try container.encode(options, forKey: .options)

        case .permissionResolved(let tabId, let questionId):
            try container.encode(TypeKey.permissionResolved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(questionId, forKey: .questionId)

        case .conversationHistory(let tabId, let messages, let hasMore, let cursor):
            try container.encode(TypeKey.conversationHistory, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(messages, forKey: .messages)
            try container.encode(hasMore, forKey: .hasMore)
            try container.encodeIfPresent(cursor, forKey: .cursor)

        case .messageAdded(let tabId, let message):
            try container.encode(TypeKey.messageAdded, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(message, forKey: .message)

        case .messageUpdated(let tabId, let messageId, let content, let toolStatus, let toolInput):
            try container.encode(TypeKey.messageUpdated, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(messageId, forKey: .messageId)
            try container.encodeIfPresent(content, forKey: .content)
            try container.encodeIfPresent(toolStatus, forKey: .toolStatus)
            try container.encodeIfPresent(toolInput, forKey: .toolInput)

        case .queueUpdate(let tabId, let prompts):
            try container.encode(TypeKey.queueUpdate, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(prompts, forKey: .prompts)

        case .error(let tabId, let message):
            try container.encode(TypeKey.error, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(message, forKey: .message)

        case .unpair:
            try container.encode(TypeKey.unpair, forKey: .type)

        case .relayConfig(let relayUrl, let relayApiKey):
            try container.encode(TypeKey.relayConfig, forKey: .type)
            try container.encode(relayUrl, forKey: .relayUrl)
            try container.encode(relayApiKey, forKey: .relayApiKey)

        case .peerDisconnected:
            try container.encode(TypeKey.peerDisconnected, forKey: .type)

        case .transportReconnecting:
            try container.encode(TypeKey.transportReconnecting, forKey: .type)

        case .inputPrefill(let tabId, let text, let switchTo):
            try container.encode(TypeKey.inputPrefill, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(text, forKey: .text)
            if switchTo { try container.encode(true, forKey: .switchTo) }

        case .terminalOutput(let tabId, let instanceId, let data):
            try container.encode(TypeKey.terminalOutput, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(data, forKey: .data)

        case .terminalExit(let tabId, let instanceId, let exitCode):
            try container.encode(TypeKey.terminalExit, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            try container.encode(exitCode, forKey: .exitCode)

        case .terminalInstanceAdded(let tabId, let instance):
            try container.encode(TypeKey.terminalInstanceAdded, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instance, forKey: .instance)

        case .terminalInstanceRemoved(let tabId, let instanceId):
            try container.encode(TypeKey.terminalInstanceRemoved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)

        case .terminalSnapshot(let tabId, let instances, let activeInstanceId, let buffers):
            try container.encode(TypeKey.terminalSnapshot, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instances, forKey: .instances)
            try container.encodeIfPresent(activeInstanceId, forKey: .activeInstanceId)
            try container.encodeIfPresent(buffers, forKey: .buffers)
        }
    }

}

// MARK: - TabStatus

enum TabStatus: String, Codable, Sendable {
    case connecting, idle, running, completed, failed, dead
}

// MARK: - PermissionOption

struct PermissionOption: Codable, Identifiable, Sendable {
    let id: String
    let label: String
    let kind: String?
}

// MARK: - AnyCodable

/// Type-erased Codable wrapper for arbitrary JSON values.
struct AnyCodable: Codable, Sendable {
    let value: any Sendable

    init(_ value: any Sendable) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let str = try? container.decode(String.self) { value = str }
        else if let int = try? container.decode(Int.self) { value = int }
        else if let double = try? container.decode(Double.self) { value = double }
        else if let bool = try? container.decode(Bool.self) { value = bool }
        else if let dict = try? container.decode([String: AnyCodable].self) { value = dict }
        else if let arr = try? container.decode([AnyCodable].self) { value = arr }
        else if container.decodeNil() { value = NSNull() }
        else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON type")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let s as String: try container.encode(s)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let b as Bool: try container.encode(b)
        case let dict as [String: AnyCodable]: try container.encode(dict)
        case let arr as [AnyCodable]: try container.encode(arr)
        case is NSNull: try container.encodeNil()
        default:
            throw EncodingError.invalidValue(
                value,
                .init(codingPath: encoder.codingPath, debugDescription: "Unsupported type for encoding")
            )
        }
    }
}
