import Foundation

/// Events sent from Ion to the iOS app.
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
    // Engine events (structured)
    case engineAgentState(tabId: String, instanceId: String?, agents: [AgentStateUpdate])
    case engineStatus(tabId: String, instanceId: String?, fields: StatusFields)
    case engineWorkingMessage(tabId: String, instanceId: String?, message: String)
    case engineToolStart(tabId: String, instanceId: String?, toolName: String, toolId: String)
    case engineToolEnd(tabId: String, instanceId: String?, toolId: String, result: String?, isError: Bool)
    case engineError(tabId: String, instanceId: String?, message: String)
    case engineNotify(tabId: String, instanceId: String?, message: String, level: String)
    case engineDialog(tabId: String, instanceId: String?, dialogId: String, method: String, title: String, options: [String]?, defaultValue: String?)
    case engineDialogResolved(tabId: String, instanceId: String?, dialogId: String)
    case engineTextDelta(tabId: String, instanceId: String?, text: String)
    case engineMessageEnd(tabId: String, instanceId: String?, inputTokens: Int, outputTokens: Int, contextPercent: Double, cost: Double)
    case engineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String])
    case engineInstanceAdded(tabId: String, instanceId: String, label: String)
    case engineInstanceRemoved(tabId: String, instanceId: String)

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
        case engineAgentState = "engine_agent_state"
        case engineStatus = "engine_status"
        case engineWorkingMessage = "engine_working_message"
        case engineToolStart = "engine_tool_start"
        case engineToolEnd = "engine_tool_end"
        case engineError = "engine_error"
        case engineNotify = "engine_notify"
        case engineDialog = "engine_dialog"
        case engineDialogResolved = "engine_dialog_resolved"
        case engineTextDelta = "engine_text_delta"
        case engineMessageEnd = "engine_message_end"
        case engineDead = "engine_dead"
        case engineInstanceAdded = "engine_instance_added"
        case engineInstanceRemoved = "engine_instance_removed"
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
        case level, dialogId, method, title, defaultValue
        case agents, fields, inputTokens, outputTokens, contextPercent
        case signal, stderrTail, label
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

        case .engineAgentState:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let agents = try container.decode([AgentStateUpdate].self, forKey: .agents)
            self = .engineAgentState(tabId: tabId, instanceId: instanceId, agents: agents)

        case .engineStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let fields = try container.decode(StatusFields.self, forKey: .fields)
            self = .engineStatus(tabId: tabId, instanceId: instanceId, fields: fields)

        case .engineWorkingMessage:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decode(String.self, forKey: .message)
            self = .engineWorkingMessage(tabId: tabId, instanceId: instanceId, message: message)

        case .engineToolStart:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let toolId = try container.decode(String.self, forKey: .toolId)
            self = .engineToolStart(tabId: tabId, instanceId: instanceId, toolName: toolName, toolId: toolId)

        case .engineToolEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let result = try container.decodeIfPresent(String.self, forKey: .result)
            let isError = try container.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            self = .engineToolEnd(tabId: tabId, instanceId: instanceId, toolId: toolId, result: result, isError: isError)

        case .engineError:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decode(String.self, forKey: .message)
            self = .engineError(tabId: tabId, instanceId: instanceId, message: message)

        case .engineNotify:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decode(String.self, forKey: .message)
            let level = try container.decode(String.self, forKey: .level)
            self = .engineNotify(tabId: tabId, instanceId: instanceId, message: message, level: level)

        case .engineDialog:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            let method = try container.decode(String.self, forKey: .method)
            let title = try container.decode(String.self, forKey: .title)
            let options = try container.decodeIfPresent([String].self, forKey: .options)
            let defaultValue = try container.decodeIfPresent(String.self, forKey: .defaultValue)
            self = .engineDialog(tabId: tabId, instanceId: instanceId, dialogId: dialogId, method: method, title: title, options: options, defaultValue: defaultValue)

        case .engineDialogResolved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            self = .engineDialogResolved(tabId: tabId, instanceId: instanceId, dialogId: dialogId)

        case .engineTextDelta:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let text = try container.decode(String.self, forKey: .text)
            self = .engineTextDelta(tabId: tabId, instanceId: instanceId, text: text)

        case .engineMessageEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let inputTokens = try container.decode(Int.self, forKey: .inputTokens)
            let outputTokens = try container.decode(Int.self, forKey: .outputTokens)
            let contextPercent = try container.decode(Double.self, forKey: .contextPercent)
            let cost = try container.decode(Double.self, forKey: .costUsd)
            self = .engineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: inputTokens, outputTokens: outputTokens, contextPercent: contextPercent, cost: cost)

        case .engineDead:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
            let signal = try container.decodeIfPresent(String.self, forKey: .signal)
            let stderrTail = try container.decodeIfPresent([String].self, forKey: .stderrTail) ?? []
            self = .engineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        case .engineInstanceAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instance = try container.decode(EngineInstancePayload.self, forKey: .instance)
            self = .engineInstanceAdded(tabId: tabId, instanceId: instance.id, label: instance.label)

        case .engineInstanceRemoved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            self = .engineInstanceRemoved(tabId: tabId, instanceId: instanceId)
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

        case .engineAgentState(let tabId, let instanceId, let agents):
            try container.encode(TypeKey.engineAgentState, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(agents, forKey: .agents)

        case .engineStatus(let tabId, let instanceId, let fields):
            try container.encode(TypeKey.engineStatus, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(fields, forKey: .fields)

        case .engineWorkingMessage(let tabId, let instanceId, let message):
            try container.encode(TypeKey.engineWorkingMessage, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)

        case .engineToolStart(let tabId, let instanceId, let toolName, let toolId):
            try container.encode(TypeKey.engineToolStart, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(toolId, forKey: .toolId)

        case .engineToolEnd(let tabId, let instanceId, let toolId, let result, let isError):
            try container.encode(TypeKey.engineToolEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolId, forKey: .toolId)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encode(isError, forKey: .isError)

        case .engineError(let tabId, let instanceId, let message):
            try container.encode(TypeKey.engineError, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)

        case .engineNotify(let tabId, let instanceId, let message, let level):
            try container.encode(TypeKey.engineNotify, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            try container.encode(level, forKey: .level)

        case .engineDialog(let tabId, let instanceId, let dialogId, let method, let title, let options, let defaultValue):
            try container.encode(TypeKey.engineDialog, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(dialogId, forKey: .dialogId)
            try container.encode(method, forKey: .method)
            try container.encode(title, forKey: .title)
            try container.encodeIfPresent(options, forKey: .options)
            try container.encodeIfPresent(defaultValue, forKey: .defaultValue)

        case .engineDialogResolved(let tabId, let instanceId, let dialogId):
            try container.encode(TypeKey.engineDialogResolved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(dialogId, forKey: .dialogId)

        case .engineTextDelta(let tabId, let instanceId, let text):
            try container.encode(TypeKey.engineTextDelta, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(text, forKey: .text)

        case .engineMessageEnd(let tabId, let instanceId, let inputTokens, let outputTokens, let contextPercent, let cost):
            try container.encode(TypeKey.engineMessageEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(inputTokens, forKey: .inputTokens)
            try container.encode(outputTokens, forKey: .outputTokens)
            try container.encode(contextPercent, forKey: .contextPercent)
            try container.encode(cost, forKey: .costUsd)

        case .engineDead(let tabId, let instanceId, let exitCode, let signal, let stderrTail):
            try container.encode(TypeKey.engineDead, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encodeIfPresent(exitCode, forKey: .exitCode)
            try container.encodeIfPresent(signal, forKey: .signal)
            try container.encode(stderrTail, forKey: .stderrTail)

        case .engineInstanceAdded(let tabId, let instanceId, let label):
            try container.encode(TypeKey.engineInstanceAdded, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(EngineInstancePayload(id: instanceId, label: label), forKey: .instance)

        case .engineInstanceRemoved(let tabId, let instanceId):
            try container.encode(TypeKey.engineInstanceRemoved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
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

// MARK: - AgentStateUpdate

/// Structured agent state sent from the desktop engine runtime.
/// Mirrors `AgentStateUpdate` in `src/shared/types.ts`.
struct AgentStateUpdate: Codable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let displayName: String
    let type: String          // "chief", "specialist", "staff", "consultant"
    let visibility: String    // "always", "sticky", "ephemeral"
    let status: String        // "idle", "running", "done", "error"
    let invited: Bool
    let task: String?
    let lastWork: String?
    let fullOutput: String?
    let elapsed: Double?
    let cost: Double?
    let color: String?

    /// Whether this agent should be shown in the UI based on visibility rules.
    var isVisible: Bool {
        switch visibility {
        case "always": return true
        case "sticky": return invited
        case "ephemeral": return status == "running"
        default: return true
        }
    }
}

// MARK: - StatusFields

/// Structured status bar fields from the desktop engine runtime.
/// Mirrors `StatusFields` in `src/shared/types.ts`.
struct StatusFields: Codable, Sendable {
    let label: String
    let state: String
    let team: String
    let model: String
    let contextPercent: Double
    let contextWindow: Int
    let totalCostUsd: Double?
}

// MARK: - EngineInstancePayload

/// Wire type for engine instance added/removed events.
struct EngineInstancePayload: Codable, Sendable {
    let id: String
    let label: String
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
