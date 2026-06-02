import Foundation

/// A single message in a conversation. Matches `RemoteMessage` in protocol.ts.
/// Also used for engine conversations (formerly EngineMessage).
struct Message: Codable, Identifiable, Sendable {
    let id: String
    let role: MessageRole
    var content: String
    var toolName: String?
    var toolInput: String?
    var toolId: String?
    var toolStatus: ToolStatus?
    var attachments: [MessageAttachment]?
    let timestamp: Double?
    var source: MessageSource?
    /// Engine-only: marks bootstrap/internal messages.
    var isInternal: Bool?
    /// View-only hint: number of consecutive bootstrap messages collapsed into
    /// this one. NOT encoded/decoded (excluded from CodingKeys).
    var bootstrapCollapsedCount: Int?
    /// Local UI state only -- NOT a wire protocol field, NOT persisted.
    /// Set to true by engine_message_end so the next engine_text_delta
    /// opens a fresh assistant message instead of appending to this one.
    var sealed: Bool = false

    var isUser: Bool { role == .user }
    var isAssistant: Bool { role == .assistant }
    var isTool: Bool { role == .tool }
    var isSystem: Bool { role == .system }
    var isHarness: Bool { role == .harness }

    private enum CodingKeys: String, CodingKey {
        case id, role, content, toolName, toolInput, toolId, toolStatus
        case attachments, timestamp, source
        case isInternal = "internal"
        // bootstrapCollapsedCount is deliberately excluded
    }
}

enum MessageRole: String, Codable, Sendable {
    case user, assistant, tool, system, harness
}

enum ToolStatus: String, Codable, Sendable {
    case running, completed, error
}

enum MessageSource: String, Codable, Sendable {
    case desktop, remote
}

// MARK: - Engine JSON decoding

extension Message {
    /// Decode Message from the engine wire format where role and toolStatus are
    /// raw strings and id may be String or Int.
    init(engineJSON decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EngineCodingKeys.self)

        // id: accept String or Int (coerce to String)
        if let s = try? container.decode(String.self, forKey: .id) {
            id = s
        } else if let n = try? container.decode(Int.self, forKey: .id) {
            id = String(n)
        } else {
            id = UUID().uuidString
        }

        // role: raw string -> enum
        let roleStr = try container.decodeIfPresent(String.self, forKey: .role) ?? "system"
        role = MessageRole(rawValue: roleStr) ?? .system

        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
        toolName = try container.decodeIfPresent(String.self, forKey: .toolName)
        toolId = try container.decodeIfPresent(String.self, forKey: .toolId)

        // toolStatus: raw string -> enum
        if let statusStr = try container.decodeIfPresent(String.self, forKey: .toolStatus) {
            toolStatus = ToolStatus(rawValue: statusStr)
        } else {
            toolStatus = nil
        }

        timestamp = try container.decodeIfPresent(Double.self, forKey: .timestamp)
        isInternal = try container.decodeIfPresent(Bool.self, forKey: .isInternal)

        // Engine messages don't carry these fields
        toolInput = nil
        attachments = nil
        source = nil
        bootstrapCollapsedCount = nil
    }

    private enum EngineCodingKeys: String, CodingKey {
        case id, role, content, toolName, toolId, toolStatus, timestamp
        case isInternal = "internal"
    }

    /// Decode an array of Message from engine wire-format JSON.
    static func decodeEngineArray(from container: KeyedDecodingContainer<RemoteEvent.CodingKeys>, forKey key: RemoteEvent.CodingKeys) throws -> [Message] {
        var arrayContainer = try container.nestedUnkeyedContainer(forKey: key)
        var messages: [Message] = []
        while !arrayContainer.isAtEnd {
            let decoder = try arrayContainer.superDecoder()
            let msg = try Message(engineJSON: decoder)
            messages.append(msg)
        }
        return messages
    }
}
