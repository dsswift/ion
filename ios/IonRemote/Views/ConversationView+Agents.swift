import SwiftUI

// MARK: - ConversationView agents panel (engine-only chrome)
//
// Extracted from the merged ConversationView (formerly EngineView) to keep the
// main view file under the Swift 600-line cap after the #256 view merge. The
// agent dispatch panel is DATA-driven, not tab-type-gated: `mainContent` gates
// it solely on `!visibleAgents.isEmpty`, so it renders for ANY conversation —
// plain or extension-backed — that has dispatched background sub-agents, and
// stays hidden whenever the agents list is empty. (The former
// `tabHasExtensions && …` gate was an illegitimate tab-type code fork; #256
// follow-up removed it so the only plain-vs-extension difference is the data.)
// Member of ConversationView via this extension.

extension ConversationView {

    var agentSection: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button {
                    withAnimation(IonTheme.snappySpring) {
                        agentsPanelExpanded = !isAgentsPanelExpanded
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isAgentsPanelExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                        Text("Agents")
                            .font(.caption.weight(.semibold))
                        Text("(\(visibleAgents.count))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        if runningAgentCount > 0 {
                            Text("\(runningAgentCount) active")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(theme.accent)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    withAnimation(IonTheme.snappySpring) {
                        agentPanelFullscreen.toggle()
                    }
                } label: {
                    Image(systemName: agentPanelFullscreen
                          ? "arrow.down.right.and.arrow.up.left"
                          : "arrow.up.left.and.arrow.down.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)

            if isAgentsPanelExpanded {
                let usePopup = viewModel.agentPanelFullScreenPopup
                let agentList = ScrollView {
                    VStack(spacing: 4) {
                        ForEach(visibleAgents) { agent in
                            AgentBarRow(
                                agent: agent,
                                messages: viewModel.agentConversationMessages[agent.name],
                                conversationMessages: viewModel.agentConversationMessages,
                                isLoadingMessages: viewModel.agentConversationLoading.contains(agent.name)
                                    || agent.dispatches.contains { viewModel.agentConversationLoading.contains($0.conversationId) },
                                onExpand: {
                                    if let lastDispatch = agent.dispatches.last,
                                       !lastDispatch.conversationId.isEmpty {
                                        viewModel.loadAgentDispatchConversation(
                                            agent: agent,
                                            conversationId: lastDispatch.conversationId
                                        )
                                    } else {
                                        viewModel.loadAgentConversation(agent: agent)
                                    }
                                },
                                onLoadDispatch: { convId in
                                    viewModel.loadAgentDispatchConversation(agent: agent, conversationId: convId)
                                },
                                onPreloadDispatches: { excludingConvId in
                                    viewModel.preloadAgentDispatches(agent: agent, excluding: excludingConvId)
                                },
                                onTap: usePopup ? {
                                    // No-op when agent has no content to display
                                    guard !agent.dispatches.isEmpty || agent.fullOutput != nil || agent.status == "running" else { return }
                                    // Load conversation data before presenting
                                    if let lastDispatch = agent.dispatches.last,
                                       !lastDispatch.conversationId.isEmpty {
                                        viewModel.loadAgentDispatchConversation(
                                            agent: agent,
                                            conversationId: lastDispatch.conversationId
                                        )
                                    } else {
                                        viewModel.loadAgentConversation(agent: agent)
                                    }
                                    if let lastConvId = agent.dispatches.last?.conversationId, !lastConvId.isEmpty {
                                        viewModel.preloadAgentDispatches(agent: agent, excluding: lastConvId)
                                    }
                                    selectedDispatchId = agent.dispatches.last?.id ?? agent.name
                                } : nil
                            )
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                }

                if agentPanelFullscreen {
                    agentList
                } else {
                    agentList.frame(maxHeight: 132)
                }
            }
        }
    }

}
