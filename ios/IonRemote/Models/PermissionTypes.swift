import Foundation

/// The permission, elicitation, and active-tool types a tab's state refers to.
/// Split from `RemoteTabState.swift` at the file-size cap.

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
    /// Origin and MCP context are additive desktop snapshot fields.
    var source: String?
    var server: String?
    var message: String?
    var action: String?

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
