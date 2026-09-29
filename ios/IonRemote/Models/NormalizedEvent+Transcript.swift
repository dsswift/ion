import Foundation

// MARK: - Transcript stream events

extension RemoteEvent {

    /// Decode a transcript patch (on the wire) or a transcript page (local,
    /// built from a `studio_body` reply by StudioEventMapper).
    static func decodeTranscript(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .transcriptPatch:
            return .transcriptPatch(TranscriptPatch(
                streamId: try container.decode(String.self, forKey: .streamId),
                tabId: try container.decode(String.self, forKey: .tabId),
                instanceId: try container.decodeIfPresent(String.self, forKey: .instanceId),
                conversationId: try container.decodeIfPresent(String.self, forKey: .conversationId),
                dispatchId: try container.decodeIfPresent(String.self, forKey: .dispatchId),
                epoch: try container.decode(String.self, forKey: .epoch),
                baseRev: try container.decode(Int.self, forKey: .baseRev),
                rev: try container.decode(Int.self, forKey: .rev),
                total: try container.decode(Int.self, forKey: .total),
                change: try container.decode(TranscriptChange.self, forKey: .change)
            ))

        case .transcriptPage:
            return .transcriptPage(TranscriptPage(
                tabId: try container.decode(String.self, forKey: .tabId),
                instanceId: try container.decode(String.self, forKey: .instanceId),
                conversationId: try container.decodeIfPresent(String.self, forKey: .conversationId),
                dispatchId: try container.decodeIfPresent(String.self, forKey: .dispatchId),
                streamId: try container.decode(String.self, forKey: .streamId),
                epoch: try container.decode(String.self, forKey: .epoch),
                rev: try container.decode(Int.self, forKey: .rev),
                total: try container.decode(Int.self, forKey: .total),
                startIndex: try container.decode(Int.self, forKey: .startIndex),
                rows: try container.decode([TranscriptRow].self, forKey: .rows).map(\.message),
                hasOlder: try container.decode(Bool.self, forKey: .hasMore),
                isNewest: try container.decode(Bool.self, forKey: .isNewest)
            ))

        case .transcriptUnavailable:
            return .transcriptUnavailable(
                tabId: try container.decode(String.self, forKey: .tabId),
                conversationId: try container.decodeIfPresent(String.self, forKey: .conversationId),
                dispatchId: try container.decodeIfPresent(String.self, forKey: .dispatchId),
                isNewest: try container.decode(Bool.self, forKey: .isNewest),
                reason: try container.decode(String.self, forKey: .unavailableReason)
            )

        default:
            return nil
        }
    }

    /// Encode transcript events. Returns `true` if the receiver was one.
    func encodeTranscript(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .transcriptPatch(let patch):
            try container.encode(TypeKey.transcriptPatch, forKey: .type)
            try container.encode(patch.streamId, forKey: .streamId)
            try container.encode(patch.tabId, forKey: .tabId)
            try container.encodeIfPresent(patch.instanceId, forKey: .instanceId)
            try container.encodeIfPresent(patch.conversationId, forKey: .conversationId)
            try container.encodeIfPresent(patch.dispatchId, forKey: .dispatchId)
            try container.encode(patch.epoch, forKey: .epoch)
            try container.encode(patch.baseRev, forKey: .baseRev)
            try container.encode(patch.rev, forKey: .rev)
            try container.encode(patch.total, forKey: .total)
            try container.encode(patch.change, forKey: .change)
            return true

        case .transcriptPage(let page):
            try container.encode(TypeKey.transcriptPage, forKey: .type)
            try container.encode(page.tabId, forKey: .tabId)
            try container.encode(page.instanceId, forKey: .instanceId)
            try container.encodeIfPresent(page.conversationId, forKey: .conversationId)
            try container.encodeIfPresent(page.dispatchId, forKey: .dispatchId)
            try container.encode(page.streamId, forKey: .streamId)
            try container.encode(page.epoch, forKey: .epoch)
            try container.encode(page.rev, forKey: .rev)
            try container.encode(page.total, forKey: .total)
            try container.encode(page.startIndex, forKey: .startIndex)
            try container.encode(page.rows.map(TranscriptRow.init(message:)), forKey: .rows)
            try container.encode(page.hasOlder, forKey: .hasMore)
            try container.encode(page.isNewest, forKey: .isNewest)
            return true

        case .transcriptUnavailable(let tabId, let conversationId, let dispatchId, let isNewest, let reason):
            try container.encode(TypeKey.transcriptUnavailable, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(conversationId, forKey: .conversationId)
            try container.encodeIfPresent(dispatchId, forKey: .dispatchId)
            try container.encode(isNewest, forKey: .isNewest)
            try container.encode(reason, forKey: .unavailableReason)
            return true

        default:
            return false
        }
    }
}
