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

    /// Load conversation history via the unified wire command.
    /// WI-004 / #259: desktop_load_conversation handles every tab — plain and
    /// extension-hosted alike. The former tabHasExtensions fork
    /// (desktop_load_engine_conversation for engine tabs) is retired: with
    /// WI-001/WI-002 landed all messages live on the active instance regardless
    /// of backend, and the unified handler pushes live engine state when the
    /// session is running.
    ///
    /// Routed through `loadConversationIfNeeded`: this is a view-appear path,
    /// and the snapshot pre-load has normally already fetched the transcript by
    /// the time the view is pushed. Asking again produced a duplicate the
    /// desktop coalesced and never answered, which is what kept the
    /// "Loading conversation…" spinner on screen for ~5s on a tab with no
    /// history at all. Explicit reloads (retry button, reconnect heal) call
    /// `loadConversation` directly and are unaffected.
    @MainActor
    func loadConversationHistory() {
        viewModel.loadConversationIfNeeded(tabId: tabId)
    }
}
