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
    /// When true, auto-group movement is suppressed for this tab. Nil/absent decodes as false.
    var groupPinned: Bool?
    var modelOverride: String?
    /// Unix ms timestamp of the last status-changing activity (from desktop snapshot).
    var lastActivityAt: Double?

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
    /// Per-engine-instance waiting state, decoded from the desktop snapshot.
    /// Values: `"question"` (AskUserQuestion pending), `"plan-ready"`
    /// (ExitPlanMode pending), or nil/absent (no waiting state). Engine
    /// sub-tabs are independent sub-conversations on the desktop, so each
    /// instance carries its own state — `EngineInstanceBar` renders a dot
    /// when this is non-nil. The parent tab's overall waiting state comes
    /// through `permissionQueue` on the enclosing `RemoteTabState` (the
    /// desktop promotes the active instance's denial into that queue).
    var waitingState: String? = nil
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
