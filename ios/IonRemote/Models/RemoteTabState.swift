import Foundation

/// Lightweight tab projection sent from Ion.
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
    var contextPercent: Double?
    var messageCount: Int?
    var queuedPrompts: [String]?
    var isTerminalOnly: Bool?
    var isEngine: Bool?
    var terminalInstances: [TerminalInstanceInfo]?
    var activeTerminalInstanceId: String?
    var engineInstances: [EngineInstanceInfo]?
    var activeEngineInstanceId: String?
    var groupId: String?

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

// MARK: - EngineInstanceInfo

struct EngineInstanceInfo: Codable, Identifiable, Sendable {
    let id: String
    var label: String
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

// MARK: - ActiveToolInfo

/// Tracks a tool call that is currently executing on the engine.
/// Used by the iOS app to display active tool cards with elapsed time
/// and an abort button when the tool appears stalled.
struct ActiveToolInfo: Identifiable {
    let id: String        // toolId from the engine
    let toolName: String
    let startTime: Date
    var isStalled: Bool = false
}
