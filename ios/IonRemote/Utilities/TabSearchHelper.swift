import Foundation

/// Stateless helper that determines whether a tab matches a freeform search query.
///
/// Matching rules:
/// - Query is split on whitespace into individual terms.
/// - All terms must match (AND logic) — each term must appear somewhere in the
///   tab's combined searchable text.
/// - Matching is case-insensitive and substring-based.
///
/// Searchable sources (in priority order, combined into one string per tab):
///   1. Tab display title
///   2. Last-message preview
///   3. Working directory path
///   4. Cached conversation messages (content)
///   5. Cached engine messages (content)
///   6. Cached attachment names
enum TabSearchHelper {

    /// Returns `true` when every whitespace-separated term in `query` appears
    /// somewhere in the tab's combined searchable text.
    ///
    /// Returns `true` immediately when `query` is empty (no filtering).
    static func matches(
        tab: RemoteTabState,
        query: String,
        messages: [Message]?,
        engineMessages: [EngineMessage]?,
        attachments: [TabAttachmentEntry]?
    ) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }

        let terms = trimmed.lowercased().split(separator: " ").map(String.init)
        guard !terms.isEmpty else { return true }

        // Build a single combined corpus for this tab.
        var parts: [String] = []
        parts.append(tab.displayTitle)
        if let last = tab.lastMessage { parts.append(last) }
        parts.append(tab.workingDirectory)

        if let msgs = messages {
            for msg in msgs { parts.append(msg.content) }
        }
        if let eMsgs = engineMessages {
            for msg in eMsgs { parts.append(msg.content) }
        }
        if let atts = attachments {
            for att in atts {
                parts.append(att.name)
                parts.append(att.path)
            }
        }

        let corpus = parts.joined(separator: "\n").lowercased()

        // All terms must appear somewhere in the corpus.
        return terms.allSatisfy { corpus.contains($0) }
    }
}
