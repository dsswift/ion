import Foundation

/// A single row of a conversation.
///
/// A conversation's rows are the server's transcript, decoded by
/// `TranscriptRow`; field meanings are the shared `Message`'s
/// (`packages/shared/src/types-session.ts`). The phone computes none of them:
/// the steer, thinking, and intercept fields arrive on the row like any other.
/// Dispatched-agent history still decodes through `init(engineJSON:)`.
struct Message: Codable, Identifiable, Sendable {
    var id: String
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
    /// Slash-command provenance. When this user turn originated from a slash
    /// command the engine resolved and expanded, `content` holds the RAW
    /// invocation (the engine persists the raw invocation as the display turn;
    /// the expanded body is only in the LLM history). The row prefers these
    /// fields over re-parsing `content` to render the command pill. Empty for
    /// ordinary messages. Carried from the engine `SessionMessage` fields.
    var slashCommand: String?
    var slashArgs: String?
    var slashSource: String?
    var slashModelAlias: String?
    var slashModelEffective: String?
    var slashFrontmatter: [String: AnyCodable]?
    /// On a user row the server made for a prompt a client sent, the
    /// `clientMsgId` that prompt carried. A pending bubble whose id matches
    /// has arrived (SessionViewModel+PendingPrompts.swift).
    var clientMsgId: String? = nil
    /// Tool output the server cut to its wire cap: `content` is the head, and
    /// `contentBytes` is the UTF-8 size of the whole value.
    var contentTruncated: Bool = false
    var contentBytes: Int? = nil
    /// A `!` shell line the user ran themselves rather than a prompt.
    var userExecuted: Bool? = nil
    /// Background work delivery metadata. Present on messages that represent
    /// a completed background agent's work being delivered into the conversation.
    var backgroundWork: BackgroundWorkMetadata?
    /// Background task a tool row started. The server folds the task's
    /// delivery onto the row when it arrives.
    var backgroundTaskId: String?
    /// A mid-turn steer the engine has not drained yet.
    var steerPending: Bool = false
    /// A steer the engine could not deliver.
    var steerFailed: Bool = false
    /// A steer the engine drained into the conversation: the bubble is a
    /// mid-turn steer rather than a turn-opening prompt.
    var steerApplied: Bool = false
    /// The id of the "── Steer applied" divider for this steer. The two rows
    /// share this key so the grouping pass (groupConversationItems in
    /// ToolGrouping.swift) can re-emit the bubble directly after its divider,
    /// the point where the steer actually took effect.
    var steerAppliedDividerId: String? = nil
    /// On an intercept's harness row: "banner" (informational) or "redirect"
    /// (urgent, run aborted). EngineMessageRow reads this to choose visual weight.
    var interceptLevel: String? = nil
    /// Path to the plan file a plan-lifecycle divider ("── Plan created",
    /// "── Plan updated", "── Implementing plan") or an ExitPlanMode row names.
    /// EngineMessageRow reads it to make the plan slug a tappable link that
    /// opens the plan preview. Mirrors the desktop `Message.planFilePath`.
    var planFilePath: String? = nil
    /// Marker discriminator carried on system-role marker rows the engine yields
    /// on historical reload: "compaction" | "plan" | "steer" (mirrors the engine
    /// `SessionMessage.markerKind`). iOS routes marker rows by their content
    /// sentinel (`[Compaction]` / `──`) — the desktop history mapper builds the
    /// display content and carries `planFilePath` before iOS ever sees the row —
    /// so this field is NOT required for rendering. It is decoded for
    /// completeness so a client that consumes the raw engine wire directly (e.g.
    /// the `engineJSON` agent-history path) can inspect the structured payload
    /// for future routing without a contract change. Optional/additive.
    var markerKind: String? = nil
    /// Character count carried by persisted `markerKind: "steer"` rows. The
    /// engine uses it to replay a confirmation without exposing the steer body.
    var markerMessageLength: Int? = nil
    /// Lets historical clients suppress a transport marker when its adjacent
    /// delivery was engine-authored background work.
    var markerMachineAuthored: Bool? = nil

    /// Classifies an injected user turn ("structured_answer", "plan_retained",
    /// ...). Absent means an ordinary user turn. The server's transcript
    /// already leaves out the machine-to-machine injections nobody should see.
    var injectionKind: String? = nil

    /// Engine-derived phase for persisted implementation work. Optional for
    /// history entries written before the field existed.
    var implementationPhase: Bool? = nil

    /// Engine-derived: an engine-side actor authored this turn, not a user.
    /// Carried on dispatched-agent history rows (`init(engineJSON:)`).
    var machineAuthored: Bool? = nil

    // MARK: - Extended-thinking summary (issue #158)
    //
    // Populated ONLY on `role: .thinking` rows. They arrive on the server's
    // transcript rows (TranscriptRow); the legacy CodingKeys below do not
    // carry them.

    /// True while a thinking block is in progress (between block_start and
    /// block_end). Drives the live activity indicator and the "Thinking…"
    /// label on the thinking row. Set false on block_end.
    var thinkingActive: Bool = false
    /// Wall-clock duration of the reasoning block, from block_end's
    /// `thinkingElapsedSeconds`. Nil until the block ends (or when the
    /// desktop omitted it). Drives "💭 Thought for {n}s".
    var thinkingElapsedSeconds: Double? = nil
    /// Approximate thinking-token estimate from block_end's
    /// `thinkingTotalTokens`. Nil when the desktop omitted it. Rendered as a
    /// parenthetical token count when present.
    var thinkingTotalTokens: Int? = nil
    /// True for redacted_thinking blocks (encrypted reasoning with no
    /// readable text). When true the row shows "🔒 redacted reasoning"
    /// rather than promising text that does not exist.
    var thinkingRedacted: Bool = false

    /// Local UI state only, never on the wire. Whether the server has
    /// answered a prompt this phone sent (queued until desktop_prompt_result,
    /// then accepted or rejected). Set only on pending prompt bubbles.
    var deliveryState: PromptDeliveryState? = nil

    var isUser: Bool { role == .user }
    var isAssistant: Bool { role == .assistant }
    var isTool: Bool { role == .tool }
    var isSystem: Bool { role == .system }
    var isHarness: Bool { role == .harness }
    var isThinking: Bool { role == .thinking }


    /// Image attachments to render inline in a message bubble. Provider-generated
    /// images (assistant turns) and tool-returned images (tool turns) arrive as
    /// structured `attachments` of type `.image` — never as content markers and
    /// often on an empty-content turn. The desktop surfaces them via
    /// `deriveMessageImages`; iOS mirrors that here so an image-generation turn
    /// renders the image instead of a blank assistant/tool row. Empty when the
    /// message carries no image attachment.
    var imageAttachments: [MessageAttachment] {
        (attachments ?? []).filter { $0.type == .image }
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, content, toolName, toolInput, toolId, toolStatus
        case attachments, timestamp, source
        case isInternal = "internal"
        case slashCommand, slashArgs, slashSource, slashModelAlias, slashModelEffective, slashFrontmatter
        case planFilePath, markerKind, markerMessageLength, markerMachineAuthored
        case injectionKind, implementationPhase, machineAuthored
        case clientMsgId
        case backgroundWork
        case backgroundTaskId
    }
}

enum MessageRole: String, Codable, Sendable {
    case user, assistant, tool, system, harness
    /// Extended-thinking reasoning block (issue #158). Synthesized locally
    /// from the desktop_thinking_* events — the engine does not persist a
    /// "thinking" role in conversation history (reasoning rides inside the
    /// assistant block), so this case is never decoded off the engine
    /// history wire; the engineJSON decoder maps unknown roles to .system.
    case thinking
}

enum ToolStatus: String, Codable, Sendable {
    case running, completed, error
    /// Tool finished but its background work has not yet been delivered.
    case asyncPending
}

enum MessageSource: String, Codable, Sendable {
    case desktop, remote
}

enum PromptDeliveryState: Sendable {
    case queued
    case accepted
    case rejected(error: String?)
}

// MARK: - Engine JSON decoding

extension Message {
    /// Decode Message from the engine wire format where role and toolStatus are
    /// raw strings and id may be String or Int.
    init(engineJSON decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: EngineCodingKeys.self)

        // A malformed or missing id is recoverable; preserve decoder fallback behavior.
        do {
            id = try container.decode(String.self, forKey: .id)
        } catch {
            do {
                id = String(try container.decode(Int.self, forKey: .id))
            } catch {
                DiagnosticLog.log("message id decode failed; generated replacement", tag: "model.message", level: .warn)
                id = UUID().uuidString
            }
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

        // Slash-command provenance (engine SessionMessage fields). Present only
        // on user turns that originated from a resolved slash command.
        slashCommand = try container.decodeIfPresent(String.self, forKey: .slashCommand)
        slashArgs = try container.decodeIfPresent(String.self, forKey: .slashArgs)
        slashSource = try container.decodeIfPresent(String.self, forKey: .slashSource)
        slashModelAlias = try container.decodeIfPresent(String.self, forKey: .slashModelAlias)
        slashModelEffective = try container.decodeIfPresent(String.self, forKey: .slashModelEffective)
        slashFrontmatter = try container.decodeIfPresent([String: AnyCodable].self, forKey: .slashFrontmatter)

        // planFilePath on plan-lifecycle divider system messages. The desktop
        // history mapper (engine-history.ts) carries it on the wire so a
        // reloaded "Plan created"/"Plan updated"/"Implementing plan" divider
        // stays clickable on iOS — matching the live handler's behavior.
        planFilePath = try container.decodeIfPresent(String.self, forKey: .planFilePath)

        // Marker discriminator (compaction/plan/steer) carried on system-role
        // marker rows the engine yields on historical reload. Decoded for
        // completeness — iOS routes marker rows by their content sentinel, so
        // this is not required to render. When a raw engine plan-marker row is
        // decoded on this path (agent history), the engine ships the plan path
        // under `markerPlanFilePath` (not `planFilePath`); fall back to it so
        // the divider still carries a path for the tappable slug link.
        markerKind = try container.decodeIfPresent(String.self, forKey: .markerKind)
        markerMessageLength = try container.decodeIfPresent(Int.self, forKey: .markerMessageLength)
        markerMachineAuthored = try container.decodeIfPresent(Bool.self, forKey: .markerMachineAuthored)
        if planFilePath == nil {
            planFilePath = try container.decodeIfPresent(String.self, forKey: .markerPlanFilePath)
        }

        // injectionKind classifies engine-side injected user turns, and
        // machineAuthored is the engine's derived verdict on whether an
        // engine-side actor authored the turn.
        injectionKind = try container.decodeIfPresent(String.self, forKey: .injectionKind)
        implementationPhase = try container.decodeIfPresent(Bool.self, forKey: .implementationPhase)
        machineAuthored = try container.decodeIfPresent(Bool.self, forKey: .machineAuthored)

        // backgroundWork carries structured metadata for an engine-owned
        // completion input. Decoded from the engine wire on history replay.
        backgroundWork = try container.decodeIfPresent(BackgroundWorkMetadata.self, forKey: .backgroundWork)
        backgroundTaskId = try container.decodeIfPresent(String.self, forKey: .backgroundTaskId)

        // Engine SessionMessage carries image references on historical reload
        // in `attachments` (engine flattenEntries replays a persisted tool-result
        // image as a SessionMessageAttachment on the owning tool row). Decode it
        // so engine-generated images survive reload on the direct engine-wire
        // path (agent conversation history), matching the desktop→iOS
        // conversationHistory path which decodes attachments via the standard
        // Codable init. Without this the images are dropped on reload.
        attachments = try container.decodeIfPresent([MessageAttachment].self, forKey: .attachments)

        // The engine DOES carry toolInput on history rows
        // (`types.Message.ToolInput`, json `toolInput`). It was dropped here
        // under a comment claiming otherwise, which silently removed the only
        // field a client needs to reconstruct what a tool was asked to do —
        // and left charts, which are derived entirely from a RenderChart
        // row's input, unrenderable on the agent-history path.
        toolInput = try container.decodeIfPresent(String.self, forKey: .toolInput)
        source = nil
    }

    private enum EngineCodingKeys: String, CodingKey {
        case id, role, content, toolName, toolInput, toolId, toolStatus, timestamp
        case isInternal = "internal"
        case slashCommand, slashArgs, slashSource, slashModelAlias, slashModelEffective, slashFrontmatter
        case planFilePath
        case markerKind, markerMessageLength, markerMachineAuthored, markerPlanFilePath
        case injectionKind, implementationPhase, machineAuthored
        case backgroundWork, backgroundTaskId
        case attachments
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
