import Foundation

/// A single message in a conversation. Matches `RemoteMessage` in protocol.ts.
struct Message: Codable, Identifiable, Sendable {
    let id: String
    let role: MessageRole
    var content: String
    var toolName: String?
    var toolInput: String?
    var toolId: String?
    var toolStatus: ToolStatus?
    var attachments: [MessageAttachment]?
    let timestamp: Double
    var source: MessageSource?

    var isUser: Bool { role == .user }
    var isAssistant: Bool { role == .assistant }
    var isTool: Bool { role == .tool }
    var isSystem: Bool { role == .system }
}

enum MessageRole: String, Codable, Sendable {
    case user, assistant, tool, system
}

enum ToolStatus: String, Codable, Sendable {
    case running, completed, error
}

enum MessageSource: String, Codable, Sendable {
    case desktop, remote
}
