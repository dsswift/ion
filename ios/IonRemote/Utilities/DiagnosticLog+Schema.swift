import Foundation

// MARK: - Canonical JSONL schema emission + correlation ID setters

extension DiagnosticLog {

    /// One canonical Ion log line. Encodes to a single-line JSON object per the
    /// schema in `docs/observability/log-schema.md`.
    ///
    /// Optional correlation/label fields (`tag`, `session_id`, `conversation_id`)
    /// are declared as optionals and encoded with a manual `encode(to:)` that
    /// *omits the key entirely when nil*. An empty string is never a valid
    /// substitute — consumers distinguish "known" from "not in scope" by key
    /// presence.
    struct LogLine: Encodable {
        let ts: String
        let level: Level
        let component: String
        let tag: String?
        let msg: String
        let session_id: String?
        let conversation_id: String?
        let fields: [String: String]

        enum CodingKeys: String, CodingKey {
            case ts, level, component, tag, msg
            case session_id
            case conversation_id
            case fields
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(ts, forKey: .ts)
            try c.encode(level, forKey: .level)
            try c.encode(component, forKey: .component)
            // Omit-when-nil / omit-when-empty for tag.
            if let tag, !tag.isEmpty {
                try c.encode(tag, forKey: .tag)
            }
            try c.encode(msg, forKey: .msg)
            // Omit-when-nil: never emit "" for correlation IDs.
            if let session_id, !session_id.isEmpty {
                try c.encode(session_id, forKey: .session_id)
            }
            if let conversation_id, !conversation_id.isEmpty {
                try c.encode(conversation_id, forKey: .conversation_id)
            }
            // fields is REQUIRED and always present ({} when empty).
            try c.encode(fields, forKey: .fields)
        }
    }

    /// Build one JSONL line (including trailing `\n`) for an entry.
    /// Called on `writeQueue`, so correlation-ID reads are already serialized.
    func encodeLine(entry: Entry, fields: [String: String]) -> String {
        let line = LogLine(
            ts: tsFormatter.string(from: entry.timestamp),
            level: entry.level,
            component: "ios",
            tag: entry.tag,
            msg: entry.message,
            session_id: currentSessionId,
            conversation_id: currentConversationId,
            fields: fields
        )
        guard let data = try? jsonEncoder.encode(line),
              let json = String(data: data, encoding: .utf8) else {
            // Fallback: emit a minimal valid line so a bad payload never
            // silently drops a log entry.
            let ts = tsFormatter.string(from: entry.timestamp)
            return "{\"ts\":\"\(ts)\",\"level\":\"\(entry.level.rawValue)\",\"component\":\"ios\",\"msg\":\"<encode-failed>\",\"fields\":{}}\n"
        }
        return json + "\n"
    }

    // MARK: - Correlation ID setters

    /// Set the engine session id stamped onto subsequent log lines.
    /// Pass nil to clear (e.g. on disconnect). Omitted-when-nil at emit time.
    static func setSessionId(_ id: String?) {
        shared.writeQueue.async { [weak shared] in
            shared?._setSessionIdOnQueue(id)
        }
    }

    /// Set the active conversation id stamped onto subsequent log lines.
    /// Pass nil to clear. Omitted-when-nil at emit time.
    static func setConversationId(_ id: String?) {
        shared.writeQueue.async { [weak shared] in
            shared?._setConversationIdOnQueue(id)
        }
    }
}
