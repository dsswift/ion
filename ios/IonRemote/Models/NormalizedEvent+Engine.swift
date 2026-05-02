import Foundation

// MARK: - Engine events

extension RemoteEvent {

    /// Decode structured engine events from the desktop runtime.
    static func decodeEngine(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .engineAgentState:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let agents = try container.decode([AgentStateUpdate].self, forKey: .agents)
            return .engineAgentState(tabId: tabId, instanceId: instanceId, agents: agents)

        case .engineStatus:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let fields = try container.decode(StatusFields.self, forKey: .fields)
            return .engineStatus(tabId: tabId, instanceId: instanceId, fields: fields)

        case .engineWorkingMessage:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            return .engineWorkingMessage(tabId: tabId, instanceId: instanceId, message: message)

        case .engineToolStart:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let toolId = try container.decode(String.self, forKey: .toolId)
            return .engineToolStart(tabId: tabId, instanceId: instanceId, toolName: toolName, toolId: toolId)

        case .engineToolEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let result = try container.decodeIfPresent(String.self, forKey: .result)
            let isError = try container.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            return .engineToolEnd(tabId: tabId, instanceId: instanceId, toolId: toolId, result: result, isError: isError)

        case .engineToolStalled:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let toolId = try container.decode(String.self, forKey: .toolId)
            let toolName = try container.decode(String.self, forKey: .toolName)
            let elapsed = try container.decode(Double.self, forKey: .elapsed)
            return .engineToolStalled(tabId: tabId, instanceId: instanceId, toolId: toolId, toolName: toolName, elapsed: elapsed)

        case .engineError:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            return .engineError(tabId: tabId, instanceId: instanceId, message: message)

        case .engineNotify:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let level = try container.decodeIfPresent(String.self, forKey: .level) ?? "info"
            return .engineNotify(tabId: tabId, instanceId: instanceId, message: message, level: level)

        case .engineDialog:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            let method = try container.decode(String.self, forKey: .method)
            let title = try container.decode(String.self, forKey: .title)
            let options = try container.decodeIfPresent([String].self, forKey: .options)
            let defaultValue = try container.decodeIfPresent(String.self, forKey: .defaultValue)
            return .engineDialog(tabId: tabId, instanceId: instanceId, dialogId: dialogId, method: method, title: title, options: options, defaultValue: defaultValue)

        case .engineDialogResolved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let dialogId = try container.decode(String.self, forKey: .dialogId)
            return .engineDialogResolved(tabId: tabId, instanceId: instanceId, dialogId: dialogId)

        case .engineTextDelta:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
            return .engineTextDelta(tabId: tabId, instanceId: instanceId, text: text)

        case .engineMessageEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            // Usage is a nested object: { inputTokens, outputTokens, contextPercent, cost }
            let usage = try container.decodeIfPresent(EngineMessageEndUsage.self, forKey: .usage)
            return .engineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, contextPercent: usage?.contextPercent ?? 0, cost: usage?.cost ?? 0)

        case .engineDead:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
            let signal = try container.decodeIfPresent(String.self, forKey: .signal)
            let stderrTail = try container.decodeIfPresent([String].self, forKey: .stderrTail) ?? []
            return .engineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        case .engineInstanceAdded:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instance = try container.decode(EngineInstancePayload.self, forKey: .instance)
            return .engineInstanceAdded(tabId: tabId, instanceId: instance.id, label: instance.label)

        case .engineInstanceRemoved:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decode(String.self, forKey: .instanceId)
            return .engineInstanceRemoved(tabId: tabId, instanceId: instanceId)

        case .engineHarnessMessage:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
            let source = try container.decodeIfPresent(String.self, forKey: .source)
            return .engineHarnessMessage(tabId: tabId, instanceId: instanceId, message: message, source: source)

        case .engineConversationHistory:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let messages = try container.decode([EngineMessage].self, forKey: .messages)
            return .engineConversationHistory(tabId: tabId, instanceId: instanceId, messages: messages)

        case .engineModelOverride:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            let model = try container.decode(String.self, forKey: .model)
            return .engineModelOverride(tabId: tabId, instanceId: instanceId, model: model)

        case .engineProfiles:
            let profiles = try container.decode([EngineProfile].self, forKey: .profiles)
            return .engineProfiles(profiles: profiles)

        default:
            return nil
        }
    }

    /// Encode engine events. Returns `true` if the receiver was an engine event.
    func encodeEngine(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .engineAgentState(let tabId, let instanceId, let agents):
            try container.encode(TypeKey.engineAgentState, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(agents, forKey: .agents)
            return true

        case .engineStatus(let tabId, let instanceId, let fields):
            try container.encode(TypeKey.engineStatus, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(fields, forKey: .fields)
            return true

        case .engineWorkingMessage(let tabId, let instanceId, let message):
            try container.encode(TypeKey.engineWorkingMessage, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            return true

        case .engineToolStart(let tabId, let instanceId, let toolName, let toolId):
            try container.encode(TypeKey.engineToolStart, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(toolId, forKey: .toolId)
            return true

        case .engineToolEnd(let tabId, let instanceId, let toolId, let result, let isError):
            try container.encode(TypeKey.engineToolEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolId, forKey: .toolId)
            try container.encodeIfPresent(result, forKey: .result)
            try container.encode(isError, forKey: .isError)
            return true

        case .engineToolStalled(let tabId, let instanceId, let toolId, let toolName, let elapsed):
            try container.encode(TypeKey.engineToolStalled, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(toolId, forKey: .toolId)
            try container.encode(toolName, forKey: .toolName)
            try container.encode(elapsed, forKey: .elapsed)
            return true

        case .engineError(let tabId, let instanceId, let message):
            try container.encode(TypeKey.engineError, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            return true

        case .engineNotify(let tabId, let instanceId, let message, let level):
            try container.encode(TypeKey.engineNotify, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            try container.encode(level, forKey: .level)
            return true

        case .engineDialog(let tabId, let instanceId, let dialogId, let method, let title, let options, let defaultValue):
            try container.encode(TypeKey.engineDialog, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(dialogId, forKey: .dialogId)
            try container.encode(method, forKey: .method)
            try container.encode(title, forKey: .title)
            try container.encodeIfPresent(options, forKey: .options)
            try container.encodeIfPresent(defaultValue, forKey: .defaultValue)
            return true

        case .engineDialogResolved(let tabId, let instanceId, let dialogId):
            try container.encode(TypeKey.engineDialogResolved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(dialogId, forKey: .dialogId)
            return true

        case .engineTextDelta(let tabId, let instanceId, let text):
            try container.encode(TypeKey.engineTextDelta, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(text, forKey: .text)
            return true

        case .engineMessageEnd(let tabId, let instanceId, let inputTokens, let outputTokens, let contextPercent, let cost):
            try container.encode(TypeKey.engineMessageEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(EngineMessageEndUsage(inputTokens: inputTokens, outputTokens: outputTokens, contextPercent: contextPercent, cost: cost), forKey: .usage)
            return true

        case .engineDead(let tabId, let instanceId, let exitCode, let signal, let stderrTail):
            try container.encode(TypeKey.engineDead, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encodeIfPresent(exitCode, forKey: .exitCode)
            try container.encodeIfPresent(signal, forKey: .signal)
            try container.encode(stderrTail, forKey: .stderrTail)
            return true

        case .engineInstanceAdded(let tabId, let instanceId, let label):
            try container.encode(TypeKey.engineInstanceAdded, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(EngineInstancePayload(id: instanceId, label: label), forKey: .instance)
            return true

        case .engineInstanceRemoved(let tabId, let instanceId):
            try container.encode(TypeKey.engineInstanceRemoved, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(instanceId, forKey: .instanceId)
            return true

        case .engineHarnessMessage(let tabId, let instanceId, let message, let source):
            try container.encode(TypeKey.engineHarnessMessage, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(source, forKey: .source)
            return true

        case .engineConversationHistory(let tabId, let instanceId, let messages):
            try container.encode(TypeKey.engineConversationHistory, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(messages, forKey: .messages)
            return true

        case .engineModelOverride(let tabId, let instanceId, let model):
            try container.encode(TypeKey.engineModelOverride, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(model, forKey: .model)
            return true

        case .engineProfiles(let profiles):
            try container.encode(TypeKey.engineProfiles, forKey: .type)
            try container.encode(profiles, forKey: .profiles)
            return true

        default:
            return false
        }
    }
}

// MARK: - AgentStateUpdate

/// Structured agent state sent from the desktop engine runtime.
/// The wire format has `name`, `status`, and a `metadata` map containing
/// all other fields (displayName, type, visibility, invited, etc.).
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

    private enum CodingKeys: String, CodingKey {
        case name, status, metadata
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        status = try container.decode(String.self, forKey: .status)
        let meta = try container.decodeIfPresent([String: AnyCodable].self, forKey: .metadata) ?? [:]

        displayName = (meta["displayName"]?.value as? String) ?? name
        type = (meta["type"]?.value as? String) ?? "specialist"
        visibility = (meta["visibility"]?.value as? String) ?? "ephemeral"
        task = meta["task"]?.value as? String
        lastWork = meta["lastWork"]?.value as? String
        fullOutput = meta["fullOutput"]?.value as? String
        color = meta["color"]?.value as? String

        // Bool and numeric values may arrive as various types
        if let inv = meta["invited"]?.value as? Bool {
            invited = inv
        } else if let inv = meta["invited"]?.value as? Int {
            invited = inv != 0
        } else {
            invited = false
        }
        if let e = meta["elapsed"]?.value as? Double {
            elapsed = e
        } else if let e = meta["elapsed"]?.value as? Int {
            elapsed = Double(e)
        } else {
            elapsed = nil
        }
        if let c = meta["cost"]?.value as? Double {
            cost = c
        } else if let c = meta["cost"]?.value as? Int {
            cost = Double(c)
        } else {
            cost = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(status, forKey: .status)
        var meta: [String: AnyCodable] = [
            "displayName": AnyCodable(displayName),
            "type": AnyCodable(type),
            "visibility": AnyCodable(visibility),
            "invited": AnyCodable(invited),
        ]
        if let task { meta["task"] = AnyCodable(task) }
        if let lastWork { meta["lastWork"] = AnyCodable(lastWork) }
        if let fullOutput { meta["fullOutput"] = AnyCodable(fullOutput) }
        if let elapsed { meta["elapsed"] = AnyCodable(elapsed) }
        if let cost { meta["cost"] = AnyCodable(cost) }
        if let color { meta["color"] = AnyCodable(color) }
        try container.encode(meta, forKey: .metadata)
    }
}

// MARK: - StatusFields

/// Structured status bar fields from the desktop engine runtime.
/// Mirrors `StatusFields` in `src/shared/types.ts`.
struct StatusFields: Codable, Sendable {
    var label: String
    let state: String
    let team: String?            // omitempty in Go — may be absent
    let model: String
    let contextPercent: Double
    let contextWindow: Int
    let totalCostUsd: Double?
    /// Friendly display name broadcast by the extension (e.g. "Chief of Staff").
    let extensionName: String?

    /// Returns a copy with the label replaced.
    func withLabel(_ newLabel: String) -> StatusFields {
        var copy = self
        copy.label = newLabel
        return copy
    }
}

// MARK: - EngineInstancePayload

/// Wire type for engine instance added/removed events.
struct EngineInstancePayload: Codable, Sendable {
    let id: String
    let label: String
}

// MARK: - EngineMessage

/// A single message in the engine conversation history.
/// Roles: "user", "assistant", "tool", "harness", "system".
struct EngineMessage: Identifiable, Sendable {
    let id: String
    let role: String
    var content: String
    var toolName: String?
    var toolId: String?
    var toolStatus: String?
    var timestamp: Double?
}

extension EngineMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, role, content, toolName, toolId, toolStatus, timestamp
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // id: accept String or Int (coerce to String)
        if let s = try? container.decode(String.self, forKey: .id) {
            id = s
        } else if let n = try? container.decode(Int.self, forKey: .id) {
            id = String(n)
        } else {
            id = UUID().uuidString
        }
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? "system"
        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
        toolName = try container.decodeIfPresent(String.self, forKey: .toolName)
        toolId = try container.decodeIfPresent(String.self, forKey: .toolId)
        toolStatus = try container.decodeIfPresent(String.self, forKey: .toolStatus)
        timestamp = try container.decodeIfPresent(Double.self, forKey: .timestamp)
    }
}

// MARK: - EngineMessageEndUsage

/// Nested usage stats within an engine_message_end event.
struct EngineMessageEndUsage: Codable, Sendable {
    let inputTokens: Int
    let outputTokens: Int
    let contextPercent: Double
    let cost: Double
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
