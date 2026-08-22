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
        let roots = allAgents.filter { $0.isVisible && $0.isRootLevel }
        return AgentDotResolver.sortedAgents(roots, allAgents: allAgents)
    }

    /// Rows with work still in flight. Counts an agent whose own dispatches are
    /// finished but which still owns a live descendant, so this agrees with the
    /// row dots and with the panel header rather than reporting zero while a
    /// specialist works.
    var runningAgentCount: Int {
        visibleAgents.filter { AgentDotResolver.isActive($0, in: allAgents) }.count
    }

    // MARK: - Background shells

    /// Background bash commands (Bash run_in_background + notify_on_complete)
    /// the active instance is waiting on. The shell counterpart to
    /// `runningAgentCount`, threaded into `ConversationStatusBar` alongside it
    /// so the status-bar dot ranks agents above shells exactly like
    /// `EngineInstanceBar`'s statusIndicator cascade.
    var runningShellCount: Int {
        activeBackgroundTasks.count
    }

    /// Complete active Bash inventory for the selected conversation instance.
    var activeBackgroundTasks: [BackgroundTaskState] {
        let instance = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)
        return instance?.activeBackgroundTasks ?? instance?.statusFields?.activeBackgroundTasks ?? []
    }

}
