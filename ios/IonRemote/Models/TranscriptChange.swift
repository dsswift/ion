import Foundation

/// The row field that grows while a row streams.
enum TranscriptAppendField: String, Codable, Sendable {
    case content, toolInput
}

/// One change between two published revisions of a transcript stream.
/// Mirrors `TranscriptChange` in `@ion/shared/transcript/transcript-patch`.
///
/// Indices are positions in the WHOLE transcript, not in the rows a client
/// happens to hold: a client holding only the newest page subtracts the index
/// of its first row.
enum TranscriptChange: Sendable {
    /// `text` is appended to `field` of the row at `index`, whose id is `id`.
    case append(index: Int, id: String, field: TranscriptAppendField, text: String)
    /// Replace `deleteCount` rows at `at` with `rows`.
    case splice(at: Int, deleteCount: Int, rows: [Message])
    /// Too large for one frame: take a fresh snapshot.
    case reset(reason: String)
}

extension TranscriptChange: Codable {
    private enum CodingKeys: String, CodingKey { case kind, index, id, field, text, at, deleteCount, rows, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "append":
            self = .append(
                index: try c.decode(Int.self, forKey: .index),
                id: try c.decode(String.self, forKey: .id),
                field: try c.decode(TranscriptAppendField.self, forKey: .field),
                text: try c.decode(String.self, forKey: .text)
            )
        case "splice":
            self = .splice(
                at: try c.decode(Int.self, forKey: .at),
                deleteCount: try c.decode(Int.self, forKey: .deleteCount),
                rows: try c.decode([TranscriptRow].self, forKey: .rows).map(\.message)
            )
        case "reset":
            self = .reset(reason: try c.decode(String.self, forKey: .reason))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown transcript change kind \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .append(let index, let id, let field, let text):
            try c.encode("append", forKey: .kind)
            try c.encode(index, forKey: .index)
            try c.encode(id, forKey: .id)
            try c.encode(field, forKey: .field)
            try c.encode(text, forKey: .text)
        case .splice(let at, let deleteCount, let rows):
            try c.encode("splice", forKey: .kind)
            try c.encode(at, forKey: .at)
            try c.encode(deleteCount, forKey: .deleteCount)
            try c.encode(rows.map(TranscriptRow.init(message:)), forKey: .rows)
        case .reset(let reason):
            try c.encode("reset", forKey: .kind)
            try c.encode(reason, forKey: .reason)
        }
    }

    /// The kind as the wire names it, for logs.
    var kindName: String {
        switch self {
        case .append: return "append"
        case .splice: return "splice"
        case .reset: return "reset"
        }
    }
}
