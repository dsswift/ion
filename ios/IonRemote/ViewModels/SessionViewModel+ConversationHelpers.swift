import Foundation

// MARK: - Conversation helpers

extension SessionViewModel {

    /// Deduplicate messages by ID, keeping the last occurrence's VALUE at the
    /// FIRST occurrence's POSITION. Extracted from
    /// SessionViewModel+EventHandlers.swift to keep that file under the cap.
    ///
    /// Called from `handleConversationHistory` when the desktop delivers a full
    /// conversation payload. Dedup is required because a payload can carry the
    /// same message ID more than once; the canonical (last) version must win.
    ///
    /// RC-26: the previous reversed-pass kept the last occurrence AND relocated it
    /// to the last-occurrence slot, so a recurring id jumped down-list versus the
    /// desktop's first-seen order. Anchor on first-seen position instead: record
    /// each id's position on first sight, overwrite its value in place on a later
    /// occurrence. Order then matches the desktop for both unique and repeated ids.
    func deduplicateMessages(_ msgs: [Message]) -> [Message] {
        var indexById: [String: Int] = [:]
        var result: [Message] = []
        for msg in msgs {
            if let existing = indexById[msg.id] {
                // Later occurrence: keep its value, at the first-seen position.
                result[existing] = msg
            } else {
                indexById[msg.id] = result.count
                result.append(msg)
            }
        }
        return result
    }

}
