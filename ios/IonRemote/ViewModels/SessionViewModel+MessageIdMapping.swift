import Foundation

// MARK: - Snapshot message ID mapping
//
// Historically the engine's SessionMessage had no `id` field, so the relay
// wire sent `id: ""` for every user and assistant message in a
// desktop_agent_conversation_history snapshot. When those messages reach
// groupDispatchItems -> ForEach, all user/assistant DispatchItems share
// the same identity (""), which causes SwiftUI to render duplicated or
// misplaced bubbles. SessionMessage now carries the canonical tree-entry id,
// but this mapper keeps its always-assign semantics for desktop-mapper
// parity (see below) and to stay robust against empty ids from older
// engines.
//
// This mirrors what the desktop does in agent-conversation-mapper.ts
// (mapConversationMessages) BEFORE storing messages in convMessages.
// Desktop generates "tool-<toolId>" and "<role>-<timestamp>[#n]" for every
// message it stores; iOS must do the same for the snapshot path.
//
// The push path (handleDispatchActivity) already assigns distinct IDs:
// tool messages use toolId, text messages use "dispatch-text-<seq>". Those
// IDs are NOT touched here — only the snapshot path (handleAgentConversationHistory)
// calls assignStableIds.

/// Mirror of desktop `mapConversationMessages` (agent-conversation-mapper.ts).
///
/// Rules (identical to the desktop mapper):
///   - Tool rows   (toolId non-empty): `"tool-<toolId>"`
///   - User/asst rows                : `"<role>-<timestamp>"`, where timestamp
///     is `Int64(m.timestamp ?? 0)`. If the same (role, timestamp) base key
///     appears more than once in the batch, the first occurrence keeps the
///     plain key; subsequent occurrences append `#<n>` where n is 1-based
///     (second occurrence = `#1`, third = `#2`, …).
///
/// Always-assign semantics: every message is remapped regardless of whether
/// its incoming id is empty or not. This is consistent with what the desktop
/// mapper does (it never conditionally skips id generation).
func assignStableIds(_ messages: [Message]) -> [Message] {
    // Collision counter: base-key -> number of times already seen.
    var seenCounts: [String: Int] = [:]

    return messages.map { m in
        let newId: String
        if let tid = m.toolId, !tid.isEmpty {
            // Tool rows: stable on the persisted Anthropic tool-use ID.
            newId = "tool-\(tid)"
        } else {
            // User / assistant rows: role + truncated-ms timestamp.
            let ts = Int64(m.timestamp ?? 0)
            let base = "\(m.role.rawValue)-\(ts)"
            let count = seenCounts[base] ?? 0
            seenCounts[base] = count + 1
            // First occurrence: plain base key. Subsequent: base#1, base#2, …
            newId = count == 0 ? base : "\(base)#\(count)"
        }

        // Copy-mutate so EVERY field is preserved exactly. The previous
        // field-by-field reconstruction silently dropped fields the memberwise
        // init defaulted (planFilePath, markerKind, sealed) — a reloaded
        // agent-history plan marker lost its tappable plan path.
        var copy = m
        copy.id = newId
        return copy
    }
}
