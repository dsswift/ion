import Foundation

// MARK: - Conversation helpers

extension SessionViewModel {

    /// Deduplicate messages by ID, keeping the last occurrence of each.
    /// Extracted from SessionViewModel+EventHandlers.swift to keep that
    /// file under the 600-line Swift cap.
    ///
    /// Called from `handleConversationHistory` when the desktop delivers
    /// a full conversation payload. Dedup is required because the desktop
    /// can emit the same message ID multiple times across paginated loads
    /// and optimistic inserts — keeping the last occurrence ensures the
    /// canonical version from the desktop wins over any prior optimistic
    /// version. The reversed pass preserves stable order after dedup.
    func deduplicateMessages(_ msgs: [Message]) -> [Message] {
        var seen = Set<String>()
        var result: [Message] = []
        for msg in msgs.reversed() {
            if seen.insert(msg.id).inserted {
                result.append(msg)
            }
        }
        result.reverse()
        return result
    }

}
