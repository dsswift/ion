import SwiftUI

/// Full-screen view for agent details. Presented via `.fullScreenCover`
/// when the `agentPanelFullScreenPopup` setting is enabled.
/// Reads live agent state and conversation data from the view model
/// so streaming updates appear in real time while the popup is open.
///
/// Hosts a recursive NavigationStack: each dispatched child agent
/// pushes another Transcript layer via path append. Breadcrumb bar
/// shows root > A > B; tapping a crumb pops the stack.
struct AgentDetailFullScreenView: View {
    let dispatchId: String
    let agentName: String
    let compoundKey: String
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme
    @State private var isNearBottom = true
    @State private var forceScrollCounter = 0
    @State private var navigationPath: [BreadcrumbEntry] = []

    /// Live agent from the view model's agent state array.
    private var agent: AgentStateUpdate? {
        let tabId = SessionViewModel.parseEngineSessionKey(compoundKey)
        let states = viewModel.engineInstance(tabId: tabId, instanceId: nil)?.agentStates ?? []
        // Prefer dispatch-id resolution so same-name dispatches render independently.
        if !dispatchId.isEmpty {
            return states.first { $0.dispatches.contains { $0.id == dispatchId } }
        }
        return states.first { $0.name == agentName }
    }

    /// Stable identity for tracking dispatch changes.
    private var dispatchSignature: String {
        guard let agent else { return "" }
        let ids = agent.dispatches.map(\.conversationId).joined(separator: ",")
        return "\(ids)|\(agent.status)|\(agent.dispatches.count)"
    }

    private var latestDispatchConvId: String {
        agent?.dispatches.last?.conversationId ?? ""
    }

    private var latestDispatchRunning: Bool {
        guard let agent else { return false }
        if let last = agent.dispatches.last, !last.status.isEmpty {
            return last.status == "running"
        }
        return agent.status == "running"
    }

    private let reconcileInterval: TimeInterval = 12

    /// Root display title from the tab.
    private var rootTitle: String {
        let tabId = SessionViewModel.parseEngineSessionKey(compoundKey)
        return viewModel.tab(for: tabId)?.displayTitle ?? "Root"
    }

    /// Conversation messages for the current agent.
    private var agentMessages: [Message] {
        guard let agent else { return [] }
        if let lastDispatch = agent.dispatches.last,
           !lastDispatch.conversationId.isEmpty {
            return viewModel.agentConversationMessages[lastDispatch.conversationId] ?? []
        }
        return viewModel.agentConversationMessages[dispatchId.isEmpty ? agent.name : dispatchId] ?? []
    }

    /// Pinned prompt: first user-role message in the agent conversation.
    private var pinnedPrompt: String? {
        agentMessages.first(where: { $0.role == .user })?.content
    }

    /// Child agents for the current dispatch, derived from the DURABLE
    /// agent-state list (not the one-shot dispatchTelemetry). Each child is an
    /// agent-state pill whose `dispatchParentId` equals this dispatch's id.
    ///
    /// KEY INVARIANT: when the same agent name is dispatched more than once, the
    /// engine's groupByName collapses all same-name pills into ONE representative
    /// with a merged dispatches[] array. `dispatches.last` would always point at
    /// the most-recently-added dispatch, which is WRONG when the user tapped an
    /// earlier one. We MUST use the `dispatchId` this view was opened with so
    /// dev-lead #1 shows only its own engine-dev, not dev-lead #2's. The fallback
    /// to `dispatches.last` covers the legacy path where dispatchId was not
    /// threaded (pre-fix state or extension-roster agents with no dispatch id).
    private var childAgents: [AgentStateUpdate]? {
        guard let agent else { return nil }
        let tabId = SessionViewModel.parseEngineSessionKey(compoundKey)
        // Prefer the dispatch id this view was explicitly opened with (per-instance
        // correct). Fall back to the last dispatch only when dispatchId is absent.
        let parentId: String
        if !dispatchId.isEmpty {
            parentId = dispatchId
        } else if let last = agent.dispatches.last?.id, !last.isEmpty {
            parentId = last
        } else {
            return nil
        }
        let children = viewModel.childAgentStates(tabId: tabId, parentDispatchId: parentId)
        return children.isEmpty ? nil : children
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            agentContent
                .navigationDestination(for: BreadcrumbEntry.self) { entry in
                    BreadcrumbDestinationView(
                        entry: entry,
                        compoundKey: compoundKey,
                        rootTitle: rootTitle,
                        agentName: agentName,
                        breadcrumbs: navigationPath,
                        onPopTo: { index in
                            if index < 0 {
                                navigationPath = []
                            } else {
                                navigationPath = Array(navigationPath.prefix(index + 1))
                            }
                        },
                        onOpenChild: { child in
                            navigationPath.append(child)
                        }
                    )
                }
        }
    }

    @ViewBuilder
    private var agentContent: some View {
        Group {
            if let agent {
                VStack(alignment: .leading, spacing: 0) {
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
                        },
                        pinHeader: true,
                        childAgents: childAgents ?? [],
                        onOpenChildDispatch: { dispatch, childAgent in
                            navigationPath.append(BreadcrumbEntry(
                                agentName: childAgent.name,
                                displayName: childAgent.displayName,
                                conversationId: dispatch.conversationId,
                                dispatchId: dispatch.id
                            ))
                        }
                    )
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
        // Initial load on first presentation. onChange(of: dispatchSignature) fires only
        // when the signature changes after view creation — so a dispatch already at its
        // final state when the popup opens never triggers a load and the transcript stays
        // empty ("Waiting for transcript…"). This task issues the same load on appear so
        // the transcript fetches regardless of whether the signature subsequently changes.
        .task {
            guard let agent else { return }
            DiagnosticLog.log("DISPATCH-POPUP: onAppear initial load agent=\(agent.name) convId=\(latestDispatchConvId)")
            if !latestDispatchConvId.isEmpty {
                viewModel.loadAgentDispatchConversation(agent: agent, conversationId: latestDispatchConvId)
            } else if !agent.conversationIds.isEmpty {
                viewModel.loadAgentConversation(agent: agent)
            }
        }
        .onChange(of: dispatchSignature) {
            guard let agent else { return }
            refreshConversation(for: agent)
        }
        .onReceive(Timer.publish(every: reconcileInterval, on: .main, in: .common).autoconnect()) { _ in
            guard let agent, latestDispatchRunning, !latestDispatchConvId.isEmpty else { return }
            viewModel.refreshAgentDispatchConversation(agent: agent, conversationId: latestDispatchConvId)
        }
        .onChange(of: latestDispatchRunning) { wasRunning, isRunning in
            guard wasRunning, !isRunning, let agent, !latestDispatchConvId.isEmpty else { return }
            viewModel.refreshAgentDispatchConversation(agent: agent, conversationId: latestDispatchConvId)
        }
    }

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

// MARK: - Breadcrumb navigation entry

struct BreadcrumbEntry: Hashable, Identifiable {
    let agentName: String
    let displayName: String
    let conversationId: String
    let dispatchId: String
    var id: String { dispatchId.isEmpty ? conversationId : dispatchId }
}

// MARK: - Breadcrumb destination

/// A view that renders when the user taps into a child agent dispatch.
/// Hosts the child's AgentExpandedContent with a breadcrumb bar.
private struct BreadcrumbDestinationView: View {
    let entry: BreadcrumbEntry
    let compoundKey: String
    let rootTitle: String
    let agentName: String
    let breadcrumbs: [BreadcrumbEntry]
    let onPopTo: (Int) -> Void
    /// Push a deeper child onto the breadcrumb navigation. Supplied by the
    /// parent NavigationStack owner so nested drill-down keeps working below
    /// the first breadcrumb level.
    let onOpenChild: (BreadcrumbEntry) -> Void
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    private var childAgent: AgentStateUpdate? {
        let tabId = SessionViewModel.parseEngineSessionKey(compoundKey)
        let states = viewModel.engineInstance(tabId: tabId, instanceId: nil)?.agentStates ?? []
        if !entry.dispatchId.isEmpty {
            return states.first { $0.dispatches.contains { $0.id == entry.dispatchId } }
        }
        return states.first { $0.name == entry.agentName }
    }

    /// Child agents dispatched by THIS breadcrumb's agent, derived from the
    /// DURABLE agent-state list (see the primary `childAgents` above for the
    /// rationale: survives late attach, per-instance correct). Keyed on the
    /// breadcrumb agent's own dispatch id.
    private var childAgents: [AgentStateUpdate] {
        guard let agent = childAgent else { return [] }
        let tabId = SessionViewModel.parseEngineSessionKey(compoundKey)
        guard let dispatchId = agent.dispatches.last?.id, !dispatchId.isEmpty else { return [] }
        return viewModel.childAgentStates(tabId: tabId, parentDispatchId: dispatchId)
    }

    var body: some View {
        Group {
            if let agent = childAgent {
                AgentExpandedContent(
                    agent: agent,
                    messages: viewModel.agentConversationMessages[entry.conversationId],
                    convMessageCache: viewModel.agentConversationMessages,
                    isLoadingMessages: viewModel.agentConversationLoading.contains(entry.conversationId),
                    onLoadDispatch: { convId in
                        viewModel.loadAgentDispatchConversation(agent: agent, conversationId: convId)
                    },
                    onPreloadDispatches: { excludingConvId in
                        viewModel.preloadAgentDispatches(agent: agent, excluding: excludingConvId)
                    },
                    pinHeader: true,
                    childAgents: childAgents,
                    onOpenChildDispatch: { dispatch, childAgent in
                        onOpenChild(BreadcrumbEntry(
                            agentName: childAgent.name,
                            displayName: childAgent.displayName,
                            conversationId: dispatch.conversationId,
                            dispatchId: dispatch.id
                        ))
                    }
                )
            } else {
                ContentUnavailableView(
                    "Agent Not Found",
                    systemImage: "person.slash",
                    description: Text("This agent is no longer active.")
                )
            }
        }
        .background(theme.background)
        .navigationTitle(entry.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                breadcrumbBar
            }
        }
        .task {
            guard let agent = childAgent, !entry.conversationId.isEmpty else { return }
            DiagnosticLog.log("DISPATCH-BREADCRUMB: onAppear initial load agent=\(agent.name) convId=\(entry.conversationId)")
            viewModel.loadAgentDispatchConversation(agent: agent, conversationId: entry.conversationId)
        }
    }

    /// Breadcrumb bar: root > A > B, tapping a crumb pops to that level.
    private var breadcrumbBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                Button { onPopTo(-1) } label: {
                    Text(rootTitle)
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary)
                }
                .buttonStyle(.plain)

                Text("›")
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary.opacity(0.5))

                Button { onPopTo(-1) } label: {
                    Text(agentName)
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary)
                }
                .buttonStyle(.plain)

                ForEach(Array(breadcrumbs.enumerated()), id: \.element.id) { idx, crumb in
                    Text("›")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))

                    if crumb.id == entry.id {
                        Text(crumb.displayName)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(theme.textPrimary)
                    } else {
                        Button { onPopTo(idx) } label: {
                            Text(crumb.displayName)
                                .font(.caption2)
                                .foregroundStyle(theme.textSecondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}
