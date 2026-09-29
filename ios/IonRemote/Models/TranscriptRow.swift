import Foundation

/// One row of the server's transcript, as the Studio wire carries it.
///
/// The server's store is the transcript: Studio renders its rows directly and
/// the phone receives the same rows through one projection
/// (`@ion/shared/transcript/transcript-row`). Every field that projection
/// ships is decoded here onto the phone's `Message`, and nothing is derived:
/// the phone shows the rows it was sent.
///
/// Wrapped rather than decoded through `Message`'s own `Codable`, which
/// describes a different, older shape and deliberately skips the fields the
/// phone used to compute for itself (steer state, the thinking summary).
struct TranscriptRow: Sendable {
    var message: Message
}

extension TranscriptRow: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, role, content, contentTruncated, contentBytes
        case toolName, toolInput, toolId, toolStatus, userExecuted, attachments, planFilePath
        case slashCommand, slashArgs, slashSource, slashModelAlias, slashModelEffective, slashFrontmatter
        case implementationPhase, interceptLevel, timestamp
        case steerPending, steerFailed, steerApplied, injectionKind, steerAppliedDividerId
        case thinkingActive, thinkingElapsedSeconds, thinkingTotalTokens, thinkingRedacted
        case backgroundWork, backgroundTaskId, clientMsgId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawRole = try c.decode(String.self, forKey: .role)
        let role: MessageRole
        if let known = MessageRole(rawValue: rawRole) {
            role = known
        } else {
            // A role this build does not know still renders, as a system row,
            // rather than dropping a row the server says is in the transcript.
            DiagnosticLog.log("transcript row has an unknown role; shown as system", tag: "transcript", level: .warn, fields: [
                "role": rawRole
            ])
            role = .system
        }
        var m = Message(
            id: try c.decode(String.self, forKey: .id),
            role: role,
            content: try c.decode(String.self, forKey: .content),
            timestamp: try c.decode(Double.self, forKey: .timestamp)
        )
        m.contentTruncated = try c.decodeIfPresent(Bool.self, forKey: .contentTruncated) ?? false
        m.contentBytes = try c.decodeIfPresent(Int.self, forKey: .contentBytes)
        m.toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
        m.toolInput = try c.decodeIfPresent(String.self, forKey: .toolInput)
        m.toolId = try c.decodeIfPresent(String.self, forKey: .toolId)
        if let rawStatus = try c.decodeIfPresent(String.self, forKey: .toolStatus) {
            m.toolStatus = ToolStatus(rawValue: rawStatus)
            if m.toolStatus == nil {
                DiagnosticLog.log("transcript row has an unknown tool status", tag: "transcript", level: .warn, fields: [
                    "row_id": m.id, "status": rawStatus
                ])
            }
        }
        m.userExecuted = try c.decodeIfPresent(Bool.self, forKey: .userExecuted)
        m.attachments = try c.decodeIfPresent([MessageAttachment].self, forKey: .attachments)
        m.planFilePath = try c.decodeIfPresent(String.self, forKey: .planFilePath)
        m.slashCommand = try c.decodeIfPresent(String.self, forKey: .slashCommand)
        m.slashArgs = try c.decodeIfPresent(String.self, forKey: .slashArgs)
        m.slashSource = try c.decodeIfPresent(String.self, forKey: .slashSource)
        m.slashModelAlias = try c.decodeIfPresent(String.self, forKey: .slashModelAlias)
        m.slashModelEffective = try c.decodeIfPresent(String.self, forKey: .slashModelEffective)
        m.slashFrontmatter = try c.decodeIfPresent([String: AnyCodable].self, forKey: .slashFrontmatter)
        m.implementationPhase = try c.decodeIfPresent(Bool.self, forKey: .implementationPhase)
        m.interceptLevel = try c.decodeIfPresent(String.self, forKey: .interceptLevel)
        m.steerPending = try c.decodeIfPresent(Bool.self, forKey: .steerPending) ?? false
        m.steerFailed = try c.decodeIfPresent(Bool.self, forKey: .steerFailed) ?? false
        m.steerApplied = try c.decodeIfPresent(Bool.self, forKey: .steerApplied) ?? false
        m.injectionKind = try c.decodeIfPresent(String.self, forKey: .injectionKind)
        m.steerAppliedDividerId = try c.decodeIfPresent(String.self, forKey: .steerAppliedDividerId)
        m.thinkingActive = try c.decodeIfPresent(Bool.self, forKey: .thinkingActive) ?? false
        m.thinkingElapsedSeconds = try c.decodeIfPresent(Double.self, forKey: .thinkingElapsedSeconds)
        m.thinkingTotalTokens = try c.decodeIfPresent(Int.self, forKey: .thinkingTotalTokens)
        m.thinkingRedacted = try c.decodeIfPresent(Bool.self, forKey: .thinkingRedacted) ?? false
        m.backgroundWork = try c.decodeIfPresent(BackgroundWorkMetadata.self, forKey: .backgroundWork)
        m.backgroundTaskId = try c.decodeIfPresent(String.self, forKey: .backgroundTaskId)
        m.clientMsgId = try c.decodeIfPresent(String.self, forKey: .clientMsgId)
        message = m
    }

    /// Writes the row back in the wire's shape: absent optionals and false
    /// flags are omitted, exactly as the server's projection omits them.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        let m = message
        try c.encode(m.id, forKey: .id)
        try c.encode(m.role.rawValue, forKey: .role)
        try c.encode(m.content, forKey: .content)
        try c.encode(m.timestamp ?? 0, forKey: .timestamp)
        if m.contentTruncated { try c.encode(true, forKey: .contentTruncated) }
        try c.encodeIfPresent(m.contentBytes, forKey: .contentBytes)
        try c.encodeIfPresent(m.toolName, forKey: .toolName)
        try c.encodeIfPresent(m.toolInput, forKey: .toolInput)
        try c.encodeIfPresent(m.toolId, forKey: .toolId)
        try c.encodeIfPresent(m.toolStatus?.rawValue, forKey: .toolStatus)
        try c.encodeIfPresent(m.userExecuted, forKey: .userExecuted)
        try c.encodeIfPresent(m.attachments, forKey: .attachments)
        try c.encodeIfPresent(m.planFilePath, forKey: .planFilePath)
        try c.encodeIfPresent(m.slashCommand, forKey: .slashCommand)
        try c.encodeIfPresent(m.slashArgs, forKey: .slashArgs)
        try c.encodeIfPresent(m.slashSource, forKey: .slashSource)
        try c.encodeIfPresent(m.slashModelAlias, forKey: .slashModelAlias)
        try c.encodeIfPresent(m.slashModelEffective, forKey: .slashModelEffective)
        try c.encodeIfPresent(m.slashFrontmatter, forKey: .slashFrontmatter)
        try c.encodeIfPresent(m.implementationPhase, forKey: .implementationPhase)
        try c.encodeIfPresent(m.interceptLevel, forKey: .interceptLevel)
        if m.steerPending { try c.encode(true, forKey: .steerPending) }
        if m.steerFailed { try c.encode(true, forKey: .steerFailed) }
        if m.steerApplied { try c.encode(true, forKey: .steerApplied) }
        try c.encodeIfPresent(m.injectionKind, forKey: .injectionKind)
        try c.encodeIfPresent(m.steerAppliedDividerId, forKey: .steerAppliedDividerId)
        if m.thinkingActive { try c.encode(true, forKey: .thinkingActive) }
        try c.encodeIfPresent(m.thinkingElapsedSeconds, forKey: .thinkingElapsedSeconds)
        try c.encodeIfPresent(m.thinkingTotalTokens, forKey: .thinkingTotalTokens)
        if m.thinkingRedacted { try c.encode(true, forKey: .thinkingRedacted) }
        try c.encodeIfPresent(m.backgroundWork, forKey: .backgroundWork)
        try c.encodeIfPresent(m.backgroundTaskId, forKey: .backgroundTaskId)
        try c.encodeIfPresent(m.clientMsgId, forKey: .clientMsgId)
    }
}
