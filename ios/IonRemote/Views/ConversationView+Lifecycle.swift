import SwiftUI

// MARK: - Appear-time lifecycle helpers
//
// The three helpers the view's `.task` modifiers call on appear: attachment
// diagnostics, slash-command discovery, and the history load. Extracted from
// ConversationView.swift to keep that file under the 600-line Swift cap
// (CLAUDE.md → "When a file exceeds the cap": split at a natural seam, never
// strip the comments that explain why these paths are shaped the way they are).

extension ConversationView {

    func fetchCommandsIfNeeded() {
        let dir = workingDirectory
        guard !dir.isEmpty, viewModel.discoveredCommands[dir] == nil else { return }
        viewModel.discoverCommands(directory: dir)
    }

    func logAttachmentTaskEntry(tabId: String) {
        let count = viewModel.tabAttachmentCache[tabId]?.count ?? -1
        DiagnosticLog.log("conversation view attachment task", tag: "view.conversation", fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(count)
        ])
    }

    /// Open this conversation's transcript stream.
    ///
    /// Routed through `loadConversationIfNeeded`: this is a view-appear path,
    /// and a conversation opened before is already held. The retry banner
    /// calls `loadConversation` directly.
    @MainActor
    func loadConversationHistory() {
        // The conversation is on screen: a push that opened it has arrived.
        ClientSpanBook.shared.tabVisible(tabId)
        viewModel.loadConversationIfNeeded(tabId: tabId)
    }
}
