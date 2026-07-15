import Foundation

/// A single message in a conversation. Matches `RemoteMessage` in protocol.ts.
/// Also used for engine conversations (formerly EngineMessage).
struct Message: Codable, Identifiable, Sendable {
    /// Mutable so `handleEngineMessageEnd` can RE-KEY a locally-streamed row
    /// (UUID / clientMsgId) to its canonical persisted tree-entry id carried
    /// on desktop_message_end (`entryId` / `userEntryId`). History pages key
    /// rows by those canonical ids, so the re-key is what lets a subsequent
    /// wholesale-replace anchor on the live rows instead of duplicating them.
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
    /// View-only hint: number of consecutive bootstrap messages collapsed into
    /// this one. NOT encoded/decoded (excluded from CodingKeys).
    var bootstrapCollapsedCount: Int?
    /// Local UI state only -- NOT a wire protocol field, NOT persisted.
    /// Set to true by engine_message_end so the next engine_text_delta
    /// opens a fresh assistant message instead of appending to this one.
    var sealed: Bool = false
    /// Intercept level carried from `engine_intercept.interceptLevel`.
    /// Populated only on `role: .harness` messages pushed by the
    /// `engineIntercept` handler in SessionViewModel+EngineEvents.swift.
    /// Values: "banner" (informational) | "redirect" (urgent, run aborted).
    /// EngineMessageRow reads this to choose the intercept banner style.
    /// Client-only field — NOT part of the wire protocol, NOT persisted.
    var interceptLevel: String? = nil
    /// Path to the plan file associated with a plan-lifecycle divider message.
    /// Populated only on `role: .system` divider messages whose content starts
    /// with "── Plan created", "── Plan updated", or "── Implementing plan"
    /// (built by handleEnginePlanFileWritten in
    /// SessionViewModel+EngineEvents.swift from the engine_plan_file_written
    /// event, and carried across a history reload by the desktop history mapper
    /// — engine-history.ts — which decodes here via the engineJSON path).
    /// EngineMessageRow reads it to make the plan slug a tappable link that
    /// opens the plan preview. Mirrors the desktop `Message.planFilePath`.
    /// Decoded from the wire on the engineJSON path; not a persisted local field.
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

    // MARK: - Extended-thinking summary (issue #158)
    //
    // These fields are populated ONLY on `role: .thinking` messages, which
    // are synthesized locally by the thinking accumulator
    // (SessionViewModel+ThinkingEvents.swift) from the desktop_thinking_*
    // events. They are client-only render hints — NOT wire-protocol fields
    // and NOT persisted — so they are excluded from CodingKeys below.

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

    var isUser: Bool { role == .user }
    var isAssistant: Bool { role == .assistant }
    var isTool: Bool { role == .tool }
    var isSystem: Bool { role == .system }
    var isHarness: Bool { role == .harness }
    var isThinking: Bool { role == .thinking }

    private enum CodingKeys: String, CodingKey {
        case id, role, content, toolName, toolInput, toolId, toolStatus
        case attachments, timestamp, source
        case isInternal = "internal"
        case slashCommand, slashArgs, slashSource
        case planFilePath, markerKind
        // bootstrapCollapsedCount, interceptLevel, and the thinking* summary
        // fields are deliberately excluded — all are client-only render hints.
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

        // Slash-command provenance (engine SessionMessage fields). Present only
        // on user turns that originated from a resolved slash command.
        slashCommand = try container.decodeIfPresent(String.self, forKey: .slashCommand)
        slashArgs = try container.decodeIfPresent(String.self, forKey: .slashArgs)
        slashSource = try container.decodeIfPresent(String.self, forKey: .slashSource)

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
        if planFilePath == nil {
            planFilePath = try container.decodeIfPresent(String.self, forKey: .markerPlanFilePath)
        }

        // Engine SessionMessage carries image references on historical reload
        // in `attachments` (engine flattenEntries replays a persisted tool-result
        // image as a SessionMessageAttachment on the owning tool row). Decode it
        // so engine-generated images survive reload on the direct engine-wire
        // path (agent conversation history), matching the desktop→iOS
        // conversationHistory path which decodes attachments via the standard
        // Codable init. Without this the images are dropped on reload.
        attachments = try container.decodeIfPresent([MessageAttachment].self, forKey: .attachments)

        // Engine messages don't carry these fields
        toolInput = nil
        source = nil
        bootstrapCollapsedCount = nil
    }

    private enum EngineCodingKeys: String, CodingKey {
        case id, role, content, toolName, toolId, toolStatus, timestamp
        case isInternal = "internal"
        case slashCommand, slashArgs, slashSource
        case planFilePath
        case markerKind, markerPlanFilePath
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
