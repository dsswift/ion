import Foundation

/// Lightweight tab projection sent from CODA.
/// Mirrors `RemoteTabState` in `src/main/remote/protocol.ts`.
struct RemoteTabState: Codable, Identifiable, Sendable {
    let id: String
    var title: String
    var customTitle: String?
    var status: TabStatus
    var workingDirectory: String
    var permissionMode: PermissionMode
    var permissionQueue: [PermissionRequest]
    var lastMessage: String?
    var contextTokens: Int?
    var messageCount: Int?
    var queuedPrompts: [String]?
    var isTerminalOnly: Bool?
    var terminalInstances: [TerminalInstanceInfo]?
    var activeTerminalInstanceId: String?

    var displayTitle: String {
        customTitle ?? title
    }
}

// MARK: - TerminalInstanceInfo

struct TerminalInstanceInfo: Codable, Identifiable, Sendable {
    let id: String
    var label: String
    var kind: String
    var readOnly: Bool
    var cwd: String
}

// MARK: - PermissionMode

enum PermissionMode: String, Codable, Sendable {
    case auto, plan
}

// MARK: - PermissionRequest

struct PermissionRequest: Codable, Identifiable, Sendable {
    let questionId: String
    let toolName: String
    let toolInput: [String: AnyCodable]?
    let options: [PermissionOption]

    var id: String { questionId }
}
