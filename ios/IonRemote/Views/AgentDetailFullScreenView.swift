import SwiftUI

/// Full-screen view for agent details. Presented via `.fullScreenCover`
/// when the `agentPanelFullScreenPopup` setting is enabled.
/// Reads live agent state and conversation data from the view model
/// so streaming updates appear in real time while the popup is open.
struct AgentDetailFullScreenView: View {
    let agentId: String
    let compoundKey: String
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme

    /// Live agent from the view model's agent state array.
    private var agent: AgentStateUpdate? {
        // compoundKey is "tabId:instanceId"; parse to extract both parts.
        let parts = compoundKey.split(separator: ":", maxSplits: 1)
        let tabId = parts.count >= 1 ? String(parts[0]) : compoundKey
        let instanceId = parts.count >= 2 ? String(parts[1]) : nil
        return (viewModel.engineInstance(tabId: tabId, instanceId: instanceId)?.agentStates ?? [])
            .first { $0.id == agentId }
    }

    /// Stable identity for tracking dispatch changes — the set of
    /// conversationIds across all dispatches plus the agent status.
    /// When this changes, we know new work has arrived and should
    /// re-fetch conversation data.
    private var dispatchSignature: String {
        guard let agent else { return "" }
        let ids = agent.dispatches.map(\.conversationId).joined(separator: ",")
        return "\(ids)|\(agent.status)|\(agent.dispatches.count)"
    }

    var body: some View {
        NavigationStack {
            Group {
                if let agent {
                    ScrollView {
                        AgentExpandedContent(
                            agent: agent,
                            messages: viewModel.agentConversationMessages[agent.name],
                            convMessageCache: viewModel.agentConversationMessages,
                            isLoadingMessages: viewModel.agentConversationLoading.contains(agent.name)
                                || agent.dispatches.contains { viewModel.agentConversationLoading.contains($0.conversationId) },
                            onLoadDispatch: { convId in
                                viewModel.loadAgentDispatchConversation(agent: agent, conversationId: convId)
                            },
                            onPreloadDispatches: { excludingConvId in
                                viewModel.preloadAgentDispatches(agent: agent, excluding: excludingConvId)
                            }
                        )
                        .padding(.top, 8)
                    }
                } else {
                    ContentUnavailableView(
                        "Agent Not Found",
                        systemImage: "person.slash",
                        description: Text("This agent is no longer active.")
                    )
                }
            }
            .background(theme.background)
            .navigationTitle(agent?.displayName ?? "Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            // Re-fetch conversation data when the agent's dispatches change
            // (new dispatch added, agent completed, etc.) so streaming updates
            // appear while the popup is open.
            .onChange(of: dispatchSignature) {
                guard let agent else { return }
                refreshConversation(for: agent)
            }
        }
    }

    /// Invalidates cached conversation data for the agent's dispatches
    /// and re-fetches so the popup shows fresh content.
    private func refreshConversation(for agent: AgentStateUpdate) {
        if let lastDispatch = agent.dispatches.last,
           !lastDispatch.conversationId.isEmpty {
            viewModel.refreshAgentDispatchConversation(
                agent: agent,
                conversationId: lastDispatch.conversationId
            )
        } else if !agent.conversationIds.isEmpty {
            viewModel.refreshAgentConversation(agent: agent)
        }
    }
}
