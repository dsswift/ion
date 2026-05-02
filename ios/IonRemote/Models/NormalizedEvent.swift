import Foundation

/// Events sent from Ion to the iOS app.
/// Mirrors `RemoteEvent` in `src/main/remote/protocol.ts`.
/// Manual tab group definition synced from the desktop.
struct RemoteTabGroup: Codable, Identifiable, Sendable {
    let id: String
    let label: String
    let isDefault: Bool
    let order: Int
}

enum RemoteEvent: Codable, Sendable {
    case snapshot(tabs: [RemoteTabState], recentDirectories: [String], tabGroupMode: String?, tabGroups: [RemoteTabGroup]?)
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
    case engineToolStalled(tabId: String, instanceId: String?, toolId: String, toolName: String, elapsed: Double)
    case engineError(tabId: String, instanceId: String?, message: String)
    case engineNotify(tabId: String, instanceId: String?, message: String, level: String)
    case engineDialog(tabId: String, instanceId: String?, dialogId: String, method: String, title: String, options: [String]?, defaultValue: String?)
    case engineDialogResolved(tabId: String, instanceId: String?, dialogId: String)
    case engineTextDelta(tabId: String, instanceId: String?, text: String)
    case engineMessageEnd(tabId: String, instanceId: String?, inputTokens: Int, outputTokens: Int, contextPercent: Double, cost: Double)
    case engineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String])
    case engineInstanceAdded(tabId: String, instanceId: String, label: String)
    case engineInstanceRemoved(tabId: String, instanceId: String)
    case engineHarnessMessage(tabId: String, instanceId: String?, message: String, source: String?)
    case engineConversationHistory(tabId: String, instanceId: String?, messages: [EngineMessage])
    case engineModelOverride(tabId: String, instanceId: String?, model: String)
    case engineProfiles(profiles: [EngineProfile])

    // MARK: - Codable keys

    enum TypeKey: String, Codable {
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
        case engineToolStalled = "engine_tool_stalled"
        case engineError = "engine_error"
        case engineNotify = "engine_notify"
        case engineDialog = "engine_dialog"
        case engineDialogResolved = "engine_dialog_resolved"
        case engineTextDelta = "engine_text_delta"
        case engineMessageEnd = "engine_message_end"
        case engineDead = "engine_dead"
        case engineInstanceAdded = "engine_instance_added"
        case engineInstanceRemoved = "engine_instance_removed"
        case engineHarnessMessage = "engine_harness_message"
        case engineConversationHistory = "engine_conversation_history"
        case engineModelOverride = "engine_model_override"
        case engineProfiles = "engine_profiles"
    }

    enum CodingKeys: String, CodingKey {
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
        case signal, stderrTail, label, profiles, elapsed, usage, model
        case tabGroupMode, tabGroups
    }

    // MARK: - Decoder

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(TypeKey.self, forKey: .type)

        if let event = try Self.decodeLifecycle(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeStream(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodePermission(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeTerminal(type: type, container: container) {
            self = event
            return
        }
        if let event = try Self.decodeEngine(type: type, container: container) {
            self = event
            return
        }
        // Should be unreachable: every TypeKey must be handled by exactly one family.
        throw DecodingError.dataCorruptedError(
            forKey: .type,
            in: container,
            debugDescription: "Unhandled event type: \(type.rawValue)"
        )
    }

    // MARK: - Encoder

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        if try encodeLifecycle(into: &container) { return }
        if try encodeStream(into: &container) { return }
        if try encodePermission(into: &container) { return }
        if try encodeTerminal(into: &container) { return }
        if try encodeEngine(into: &container) { return }
        // Unreachable: every case must be encoded by exactly one family.
    }
}

// MARK: - TabStatus

enum TabStatus: String, Codable, Sendable {
    case connecting, idle, running, completed, failed, dead
}
