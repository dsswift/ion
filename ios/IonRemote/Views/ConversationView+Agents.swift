import SwiftUI

// MARK: - ConversationView agent data (engine-only chrome)
//
// Agent data-source properties for ConversationView, extracted to keep the
// main view file under the Swift 600-line cap. The panel UI itself lives in
// TranscriptAgentSection (Transcript.swift); this extension supplies the
// data ConversationView threads into Transcript.

extension ConversationView {

    // MARK: - Agent set

    /// Every agent on the active instance, unfiltered. The visible list is
    /// root-scoped, but the status dots and the header counts must reason about
    /// nested specialists too: a lead reads as waiting because of a descendant
    /// that is deliberately NOT in the visible set.
    ///
    /// Lives here rather than in ConversationView.swift so that file stays
    /// under the 600-line Swift cap; these three are the agent panel's data
    /// source and belong beside the panel they feed.
    var allAgents: [AgentStateUpdate] {
        viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)?.agentStates ?? []
    }

    /// Root-level, visible agents in panel order. Nested specialists are
    /// deliberately excluded — they surface inside their lead's detail view.
    var visibleAgents: [AgentStateUpdate] {
        allAgents
            .filter { $0.isVisible && $0.isRootLevel }
            .sorted { a, b in
                let statusOrder: [String: Int] = ["running": 0, "done": 1, "error": 1, "cancelled": 1, "idle": 2]
                let visOrder: [String: Int] = ["always": 0, "sticky": 1, "ephemeral": 2]
                let sa = statusOrder[a.status] ?? 2
                let sb = statusOrder[b.status] ?? 2
                if sa != sb { return sa < sb }
                let va = visOrder[a.visibility] ?? 9
                let vb = visOrder[b.visibility] ?? 9
                if va != vb { return va < vb }
                return a.displayName.localizedCompare(b.displayName) == .orderedAscending
            }
    }

    /// Rows with work still in flight. Counts an agent whose own dispatches are
    /// finished but which still owns a live descendant, so this agrees with the
    /// row dots and with the panel header rather than reporting zero while a
    /// specialist works.
    var runningAgentCount: Int {
        visibleAgents.filter { AgentDotResolver.isActive($0, in: allAgents) }.count
    }

}
