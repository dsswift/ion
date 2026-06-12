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
    /// The current conversation/session ID for this tab. CLI tabs populate
    /// this directly; engine tabs use `StatusFields.sessionId` instead.
    var conversationId: String?
    /// Unix ms timestamp of the last status-changing activity (from desktop snapshot).
    var lastActivityAt: Double?
    /// Custom pill background color hex string (e.g. "#f08c4a"). Nil means use theme default.
    var pillColor: String?
    /// Custom pill icon key (e.g. "diamond", "star"). Nil means use the default status dot.
    var pillIcon: String?
    /// Aggregated "any sub-instance has running dispatched background
    /// agents" flag, projected by the desktop's
    /// `getRemoteTabStates` snapshot. Drives the yellow "awaiting
    /// children" pulse on the parent tab pill in `TabRowView`. Nil/
    /// absent means false — older desktops that don't emit this field
    /// continue to work, with the parent pill simply not pulsing
    /// yellow until they're upgraded. See CLAUDE.md § "Common parity
    /// surfaces" parity table for the desktop/iOS parity rule.
    var hasRunningChildren: Bool?

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

// MARK: - EngineInstanceModelFallback

/// Per-engine-instance model-fallback indicator carried on
/// EngineInstanceInfo. Populated by the desktop snapshot when the engine
/// emitted a ModelFallbackEvent for the corresponding run — i.e. the
/// requested model didn't resolve to a provider and the engine fell
/// back to its configured `defaultModel`.
///
/// iOS receives this via the snapshot path, not via a live RemoteEvent,
/// because the engine's ModelFallbackEvent is a workflow signal (fires
/// once at the swap site) — to give iOS a sticky-across-reconnect
/// indicator without a new RemoteEvent variant, the desktop projects
/// the fact onto the snapshot. See CLAUDE.md § "Common parity surfaces"
/// row for model fallback indicator and § "The typed-event corollary"
/// for the broader rule that the engine's typed event is the complete
/// signaling surface.
struct EngineInstanceModelFallback: Codable, Sendable, Equatable {
    /// The model string the run was started with (e.g. an unconfigured
    /// tier alias like "standard").
    let requestedModel: String
    /// The engine's configured `defaultModel` that the run actually used.
    let fallbackModel: String
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
    /// Per-engine-instance running state, decoded from the desktop snapshot.
    /// `true` when the instance's engine state is `running`, `connecting`,
    /// or `starting`. `EngineInstanceBar` renders a pulsing orange dot when
    /// this is true and no `waitingState` is set. The parent tab's overall
    /// status is aggregated by the snapshot — if any instance is running,
    /// `RemoteTabState.status` is promoted to `.running`.
    var isRunning: Bool? = nil
    /// Per-engine-instance dispatched-agent count, decoded from the
    /// desktop snapshot. > 0 when the instance has background agents
    /// in the `running` status — even if the orchestrator itself is
    /// idle. Drives the yellow "awaiting children" pulse on the iOS
    /// sub-tab pill in `EngineInstanceBar` (priority cascade matches
    /// the desktop: waitingState → isRunning → runningAgentCount).
    /// Nil/zero means no background agents are running. See
    /// CLAUDE.md § "Common parity surfaces" parity table.
    var runningAgentCount: Int? = nil
    /// Per-engine-instance model-fallback indicator. Non-nil when the
    /// desktop's engineModelFallbacks map holds an entry for this
    /// `tabId:instanceId` — i.e. the engine emitted ModelFallbackEvent
    /// for the current/most recent run and the run hasn't yet gone
    /// idle. `EngineInstanceBar` renders a ⚠ glyph when non-nil; tap
    /// to reveal the requested + fallback model names.
    var modelFallback: EngineInstanceModelFallback? = nil
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
/// Used by ConversationView to derive the activity indicator text
/// (e.g. "Running Bash…"). The isStalled flag is retained for potential
/// future use in the activity indicator.
struct ActiveToolInfo: Identifiable {
    let id: String        // toolId from the engine
    let toolName: String
    let startTime: Date
    var isStalled: Bool = false
}
