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
    /// Per-conversation extended-thinking effort ("low"|"medium"|"high"), or
    /// nil/absent when off. Drives the iOS thinking control. Mirrors the
    /// desktop snapshot's RemoteTabState.thinkingEffort.
    var thinkingEffort: String?
    var permissionQueue: [PermissionRequest]
    /// Live extension elicitations (ctx.elicit) awaiting a user decision on the
    /// active instance. The head entry renders an approval card; iOS answers via
    /// the `desktop_respond_elicitation` command. Optional/absent on older
    /// desktops (additive, non-breaking). Mirrors the desktop snapshot's
    /// RemoteTabState.elicitationQueue.
    var elicitationQueue: [ElicitationRequest]?
    var lastMessage: String?
    var contextTokens: Int?
    var contextPercent: Double?
    /// Engine-reported context window size (tokens) of the model the
    /// engine actually used on the most recent turn. Distinct from the
    /// picker-selected model's nominal window. ConversationStatusBar
    /// reads this as the denominator when computing percent locally so
    /// the indicator stays accurate even when the picker disagrees with
    /// the engine. Nil on cold-start tabs (no engine response yet); the
    /// indicator falls back to the picker model's nominal window in that
    /// case. See the desktop's TabState.contextWindow docs for the full
    /// rationale.
    var contextWindow: Int?
    var messageCount: Int?
    /// Conversation tail fingerprint from the desktop snapshot — the staleness
    /// signal for the main-conversation heal. iOS computes the same fingerprint
    /// (conversationTailFingerprint in SessionViewModel+Snapshot.swift) over its
    /// local tail and re-fetches history when they diverge (dropped live deltas,
    /// e.g. a LAN↔relay transport switch). Empty/nil for cold-start tabs.
    /// Algorithm pinned byte-identically with the desktop
    /// (shared/conversation-fingerprint.ts + snapshot.ts inline JS).
    var convFingerprint: String?
    var queuedPrompts: [String]?
    var isTerminalOnly: Bool?
    var hasEngineExtension: Bool?
    var terminalInstances: [TerminalInstanceInfo]?
    var activeTerminalInstanceId: String?
    var conversationInstances: [ConversationInstanceInfo]?
    var activeConversationInstanceId: String?
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
    /// Engine profile ID for this tab. Non-nil when the tab was created with
    /// a specific engine profile (i.e. `hasEngineExtension == true`). Used
    /// by `TabRowView` to resolve the profile display name for the harness
    /// badge. Mirrors `RemoteTabState.engineProfileId` in protocol.ts.
    var engineProfileId: String?
    /// Cost of the most recent run in USD (cache-aware, descendants included).
    /// Projected from StatusFields.runCostUsd via the desktop snapshot so iOS
    /// has the correct value on cold open without waiting for a live
    /// engine_status event. Nil when the tab has never had a run.
    /// Mirrors protocol.ts RemoteTabState.runCostUsd.
    var runCostUsd: Double?
    /// Cumulative cost of the entire conversation (this session + all descendant
    /// dispatches) in USD. Nil when the tab has never had a run.
    /// Mirrors protocol.ts RemoteTabState.conversationCostUsd.
    var conversationCostUsd: Double?
    /// Conversation-lifetime prompt count: the number of real user prompts
    /// across the whole conversation (engine's conversation.CountUserPrompts),
    /// NOT the per-run round-trip count. Projected from lastResult via the
    /// desktop snapshot so the StatusDrawer "Turns" row renders the lifetime
    /// value on cold open. Nil when the tab has never had a run report it.
    /// Mirrors protocol.ts RemoteTabState.conversationTurns.
    var conversationTurns: Int?
    /// @deprecated Use runCostUsd. Kept for lockstep wire compat until the
    /// desktop snapshot fully removes it. Set to the same value as runCostUsd
    /// when both fields are present. Mirrors protocol.ts RemoteTabState.totalCostUsd.
    var totalCostUsd: Double?
    /// Cumulative provider-reported input tokens for this tab. Projected from the
    /// engine's usage tracking via the desktop snapshot (cold-start parity fix,
    /// plan modest-leaping-waffle §6). Optional — absent on tabs that have never run.
    var inputTokens: Int?
    /// Cumulative output tokens. Optional — absent on never-run tabs.
    var outputTokens: Int?
    /// Cumulative cache-read tokens (Anthropic prompt caching). Optional.
    var cacheReadTokens: Int?
    /// Cumulative cache-creation tokens (Anthropic prompt caching). Optional.
    var cacheCreationTokens: Int?

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
/// ConversationInstanceInfo. Populated by the desktop snapshot when the engine
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

// MARK: - ConversationInstanceInfo

/// The single per-tab conversation record (post-#256 unification).
///
/// Mirrors the desktop's `ConversationInstance`: every non-terminal tab —
/// plain or extension — has exactly **one** of these, the `main` instance
/// (`id == ConversationInstanceInfo.mainInstanceId`). It carries all of the
/// tab's conversation state: the message list, live streaming text, agent
/// states, status, and model override.
///
/// Before #256's iOS completion, plain tabs stored their state in loose
/// top-level dictionaries on `SessionViewModel` (`messages[tabId]`,
/// `liveText[tabId]`, …) while engine tabs used this struct. The unification
/// collapses both onto this single record, reached through the accessors in
/// `SessionViewModel+Conversation.swift`.
struct ConversationInstanceInfo: Codable, Identifiable, Sendable {
    /// The canonical id for the single conversation instance every tab owns.
    /// Matches the desktop's `'main'` instance id so the two clients agree on
    /// the per-instance key for any wire surface that still carries one.
    static let mainInstanceId = "main"

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
    /// Historical conversation IDs accumulated across engine restarts,
    /// projected from the desktop snapshot. Used as a fallback for "Copy
    /// Session ID" when `statusFields?.sessionId` is nil (e.g. restored
    /// tabs before the engine reconnects, or tabs where an extension
    /// failed at startup before any prompt was sent).
    var conversationIds: [String]? = nil
    /// Per-engine-instance extended-thinking effort ("low"|"medium"|"high"),
    /// or nil/absent when off. Mirrors the desktop snapshot's per-instance
    /// thinkingEffort so iOS shows the right level for the active sub-tab.
    var thinkingEffort: String? = nil
    /// Per-instance dispatch telemetry, projected from the desktop snapshot.
    /// Also populated by live engine events (dispatch_start/end) and
    /// reconciled from the snapshot on reconnect.
    var dispatchTelemetry: [DispatchTelemetryEntry]? = nil

    /// Per-instance context breakdown from the most recent desktop_context_breakdown
    /// event. Updated by live events; nil until the engine emits a breakdown for
    /// this tab. The StatusDrawerView reads this to render the Context Breakdown
    /// section. Not persisted in the snapshot (live-only; the engine re-emits on
    /// reconnect). Mirrors ConversationInstance.contextBreakdown in the desktop store.
    var contextBreakdown: ContextBreakdownPayload? = nil

    // Non-Codable conversation state — populated by live events /
    // loadEngineConversation, not decoded from the snapshot JSON.
    var messages: [Message] = []
    // agentStates IS persisted (see CodingKeys) so the agents panel and the
    // dispatch popup/breadcrumb — which key state on dispatch id — render on
    // reload before the engine re-emits live agent-state events. Defaults to []
    // so pre-fix snapshots without the field decode cleanly.
    var agentStates: [AgentStateUpdate] = []
    var statusFields: StatusFields? = nil
    var modelOverride: String? = nil
    /// Live streaming text accumulator for the relay text-chunk path
    /// (`text_chunk`/`tool_call`/`tool_result`/`error` events that arrive
    /// before a conversation's history is loaded). Distinct from `messages`,
    /// which is the structured/loaded view. Cleared when history loads or the
    /// turn completes. Plain tabs used the old top-level `liveText[tabId]`
    /// dict; post-#256 both tab types share this field via
    /// `SessionViewModel.liveText(_:)` / `setLiveText(tabId:_:)`.
    var liveText: String = ""
    /// In-progress thinking-block accumulator: the `Message.id` of the live
    /// `.thinking` message that `thinking_block_start` created, so
    /// `thinking_delta` can append to it and `thinking_block_end` can finalize
    /// it. Nil when no reasoning block is in progress. Cleared on stream reset /
    /// history reload so a stale in-progress block never lingers. Replaces the
    /// old top-level `thinkingInProgress[compoundKey]` dict (post-#256).
    var thinkingMessageId: String? = nil
    /// Transient "working" status line the engine emits while a run is active
    /// (e.g. "Reading files…"). Distinct from `messages` and `liveText`: it is a
    /// replace-style single-line indicator rendered above the scrollback, not
    /// appended content. Empty when no working message is active. Replaces the
    /// old top-level `engineWorkingMessages[compoundKey]` dict (post-#256).
    var workingMessage: String = ""

    // Explicit CodingKeys so the live-only fields above (messages, statusFields,
    // modelOverride, liveText, thinkingMessageId, workingMessage) are excluded
    // from JSON encoding/decoding and don't break snapshot deserialization.
    // `agentStates` IS persisted (see the custom Codable in the extension below).
    enum CodingKeys: String, CodingKey {
        case id
        case label
        case waitingState
        case isRunning
        case runningAgentCount
        case modelFallback
        case conversationIds
        case thinkingEffort
        case dispatchTelemetry
        case agentStates
    }
}

// Custom Codable defined in an extension (not the main declaration) so the
// synthesized memberwise initializer is preserved for the many call sites that
// build ConversationInstanceInfo directly (tests, snapshot projection).
extension ConversationInstanceInfo {
    // Custom decode so a missing `agentStates` key falls back to the default
    // (empty) rather than throwing keyNotFound. Swift's synthesized decoder does
    // NOT apply a stored-property default for a non-optional value type when the
    // key is absent — only optionals get the decodeIfPresent → nil treatment —
    // so pre-fix snapshots (no agentStates field) would fail to decode without
    // this.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            label: try container.decode(String.self, forKey: .label)
        )
        waitingState = try container.decodeIfPresent(String.self, forKey: .waitingState)
        isRunning = try container.decodeIfPresent(Bool.self, forKey: .isRunning)
        runningAgentCount = try container.decodeIfPresent(Int.self, forKey: .runningAgentCount)
        modelFallback = try container.decodeIfPresent(EngineInstanceModelFallback.self, forKey: .modelFallback)
        conversationIds = try container.decodeIfPresent([String].self, forKey: .conversationIds)
        thinkingEffort = try container.decodeIfPresent(String.self, forKey: .thinkingEffort)
        dispatchTelemetry = try container.decodeIfPresent([DispatchTelemetryEntry].self, forKey: .dispatchTelemetry)
        agentStates = try container.decodeIfPresent([AgentStateUpdate].self, forKey: .agentStates) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        try container.encodeIfPresent(waitingState, forKey: .waitingState)
        try container.encodeIfPresent(isRunning, forKey: .isRunning)
        try container.encodeIfPresent(runningAgentCount, forKey: .runningAgentCount)
        try container.encodeIfPresent(modelFallback, forKey: .modelFallback)
        try container.encodeIfPresent(conversationIds, forKey: .conversationIds)
        try container.encodeIfPresent(thinkingEffort, forKey: .thinkingEffort)
        try container.encodeIfPresent(dispatchTelemetry, forKey: .dispatchTelemetry)
        // Only emit agentStates when non-empty to keep snapshots compact and to
        // avoid churn against fixtures that predate the field.
        if !agentStates.isEmpty {
            try container.encode(agentStates, forKey: .agentStates)
        }
    }
}

extension ConversationInstanceInfo {
    /// Resolve the active engine-instance id for a tab from a (possibly legacy
    /// multi-instance) snapshot: prefer the explicit `activeConversationInstanceId`,
    /// otherwise fall back to the first instance's id, otherwise nil.
    ///
    /// This is the single source of truth for the resolution that
    /// `SessionViewModel+Snapshot` performs when projecting a snapshot
    /// (`activeEngineInstance[tab.id] = ...`). Extracted so it is unit-testable
    /// directly — driving this function pins the *shipped* behavior rather than
    /// re-deriving a similar expression inline in a test.
    ///
    /// Post-#256 every tab is single-instance, but the engine/desktop may still
    /// deliver a legacy multi-instance snapshot during migration, so the
    /// resolution must stay correct for >1 instances.
    static func resolveActiveInstanceId(
        activeId: String?,
        instances: [ConversationInstanceInfo]
    ) -> String? {
        activeId ?? instances.first?.id
    }
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
    /// Engine instance (sub-tab) this request belongs to. Populated by the
    /// desktop for engine-view denials (both the live `permission_request`
    /// event and the snapshot queue promotion) so `ConversationView` can scope
    /// the plan/question card to the owning sub-conversation. Nil for CLI
    /// tabs and for payloads from older desktops — nil passes the
    /// active-instance filter for backward compatibility.
    var instanceId: String? = nil

    var id: String { questionId }
}

// MARK: - ElicitationRequest

/// A live extension elicitation (`ctx.elicit`) awaiting a user decision.
/// Mirrors `ElicitationRequest` in `src/shared/types-session.ts`. The engine
/// fans `engine_elicitation_request` to every client and parks the run on an
/// indefinite human-wait until one answers; iOS renders an approval card from
/// `mode` + `schema` and replies with the `desktop_respond_elicitation`
/// command keyed by `requestId`.
struct ElicitationRequest: Codable, Identifiable, Sendable {
    /// Engine-assigned id echoed back in the response command.
    let requestId: String
    /// Renderer selector ("approval", "select", ...). May be empty.
    let mode: String
    /// Harness-defined description of what is being requested.
    let schema: [String: AnyCodable]?
    /// Optional deep-link URL for web flows.
    let url: String?

    var id: String { requestId }
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
