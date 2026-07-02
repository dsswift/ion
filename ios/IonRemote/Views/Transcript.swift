import SwiftUI

// MARK: - Transcript
//
// Shared transcript SwiftUI view used by both the main ConversationView and
// AgentDetailFullScreenView (recursive dispatch popup). Hosts the
// ChatCollectionView with the full row switch (single, toolGroup, compaction,
// thinking, agentTurn), the scroll-to-bottom overlay, pinned-prompt bar,
// and embedded agent section.

struct Transcript: View {
    let messages: [Message]
    let unifiedTurnView: Bool
    /// Pinned-last-prompt bar text. Same treatment as ConversationView
    /// headerSection (the "> prompt" bar).
    let pinnedPrompt: String?
    let isRunning: Bool
    let onRewind: ((String) -> Void)?
    let agents: [AgentStateUpdate]?
    let onOpenDispatch: ((DispatchInfo, AgentStateUpdate) -> Void)?
    @Binding var isNearBottom: Bool
    var forceScrollCounter: Int
    /// Optional plan-tap handler. When non-nil, plan-lifecycle divider
    /// slug links become tappable.
    var onTapPlan: ((String) -> Void)?
    /// Controls whether the agent panel is expanded. Optional: when omitted
    /// the section defaults to expanded=true (suitable for popup call sites
    /// where agents is always nil anyway).
    var agentPanelExpanded: Binding<Bool>?
    /// Controls fullscreen mode on the agent panel. Optional: when omitted
    /// the section defaults to fullscreen=false.
    var agentPanelFullscreen: Binding<Bool>?
    /// Render the embedded agent section even when there are zero agents. The
    /// dispatch-preview (AgentDetailFullScreenView → AgentExpandedContent) sets
    /// this so the preview always carries the agent panel — showing "Agents (0)"
    /// before the lead dispatches a specialist, then populating as children
    /// spawn. The main conversation leaves it false so an agent-less
    /// conversation shows no empty panel. Mirrors the desktop `alwaysRender`.
    var alwaysShowAgentPanel: Bool = false
    @Environment(\.appTheme) private var theme

    // MARK: - Grouping

    private var groupedMessages: [ConversationView.GroupedItem] {
        // Bootstrap-collapse pre-pass: collapse consecutive harness
        // messages that start with the bootstrap prefix.
        let bootstrapPrefix = ConversationView.bootstrapPrefix
        var preprocessed: [Message] = []
        var bootstrapBuf: [Message] = []

        let flushBootstrap = {
            guard !bootstrapBuf.isEmpty else { return }
            var representative = bootstrapBuf.last!
            let suppressed = bootstrapBuf.count - 1
            if suppressed > 0 {
                representative.bootstrapCollapsedCount = suppressed
            }
            preprocessed.append(representative)
            bootstrapBuf = []
        }

        for msg in messages {
            if msg.role == .harness && msg.content.hasPrefix(bootstrapPrefix) {
                bootstrapBuf.append(msg)
            } else {
                flushBootstrap()
                preprocessed.append(msg)
            }
        }
        flushBootstrap()

        // Run through the shared grouping algorithm.
        let items = groupConversationItems(preprocessed, unifiedTurnView: unifiedTurnView)
        return items.map { item -> ConversationView.GroupedItem in
            switch item {
            case .user(let m), .assistant(let m), .system(let m):
                return .single(m)
            case .thinking(let m):
                return .thinking(m)
            case .toolGroup(let tools):
                return .toolGroup(tools)
            case .compaction(let m):
                return .compaction(m)
            case .agentTurn(let tools, let assistants, let isActive, let thinking):
                return .agentTurn(tools: tools, assistantMessages: assistants, isActive: isActive, thinking: thinking)
            }
        }
    }

    private var chatItems: [ChatItem<ConversationView.GroupedItem>] {
        groupedMessages.map { ChatItem(id: $0.id, payload: $0) }
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            if let prompt = pinnedPrompt, !prompt.isEmpty {
                HStack {
                    Text("> ")
                        .foregroundStyle(theme.accent)
                        .fontWeight(.semibold)
                    Text(prompt)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(IonTheme.codeFont(size: 12))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemFill).opacity(0.7))
            }

            ZStack(alignment: .bottom) {
                ChatCollectionView(
                    items: chatItems,
                    isNearBottom: $isNearBottom,
                    forceScrollCounter: forceScrollCounter,
                    spacing: 8,
                    horizontalInset: 12
                ) { item in
                    Group {
                        switch item {
                        case .single(let msg):
                            if msg.role == .user && !isRunning {
                                if let rewind = onRewind {
                                    EngineMessageRow(message: msg, onRewind: rewind)
                                } else {
                                    EngineMessageRow(message: msg)
                                }
                            } else {
                                if let tapPlan = onTapPlan {
                                    EngineMessageRow(message: msg, onTapPlan: tapPlan)
                                } else {
                                    EngineMessageRow(message: msg)
                                }
                            }
                        case .toolGroup(let tools):
                            EngineToolGroupRow(tools: tools)
                        case .compaction(let msg):
                            CompactionRowView(message: msg)
                        case .thinking(let msg):
                            ThinkingRowView(message: msg)
                        case .agentTurn(let tools, let assistants, let isActive, let thinking):
                            AgentTurnRow(tools: tools, assistantMessages: assistants, isActive: isActive, thinking: thinking)
                        }
                    }
                }

                if !isNearBottom {
                    Button {
                        isNearBottom = true
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 40, height: 40)
                            .background(.regularMaterial)
                            .clipShape(Circle())
                            .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
                    }
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .scale))
                }
            }
            .animation(IonTheme.snappySpring, value: isNearBottom)

            if let visibleAgents = agents, !visibleAgents.isEmpty || alwaysShowAgentPanel {
                TranscriptAgentSection(
                    agents: visibleAgents,
                    onOpenDispatch: onOpenDispatch,
                    isExpanded: agentPanelExpanded ?? .constant(true),
                    isFullscreen: agentPanelFullscreen ?? .constant(false)
                )
            }
        }
    }
}

// MARK: - TranscriptAgentSection

/// Embedded agent bar list for the Transcript view. Renders a collapsible
/// panel with a chevron header, matching the pre-migration ConversationView
/// agentSection behavior (ConversationView+Agents.swift).
///
/// State is threaded as bindings from ConversationView so that
/// `agentsPanelExpanded` and `agentPanelFullscreen` on ConversationView
/// remain the sources of truth. The chevron header toggles `isExpanded` with
/// the same `IonTheme.snappySpring` animation used before the migration.
/// The frame(maxHeight:132) cap applies when isFullscreen is false, exactly
/// as before.
struct TranscriptAgentSection: View {
    let agents: [AgentStateUpdate]
    let onOpenDispatch: ((DispatchInfo, AgentStateUpdate) -> Void)?
    @Binding var isExpanded: Bool
    @Binding var isFullscreen: Bool
    @Environment(\.appTheme) private var theme

    private var runningCount: Int {
        agents.filter { $0.status == "running" }.count
    }

    var body: some View {
        VStack(spacing: 0) {
            // MARK: Chevron header row
            //
            // Matches the pre-migration ConversationView+Agents.swift:20-56.
            // Chevron left/right toggles isExpanded; the expand/contract icon
            // on the trailing edge toggles isFullscreen.
            HStack(spacing: 4) {
                Button {
                    withAnimation(IonTheme.snappySpring) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                        Text("Agents")
                            .font(.caption.weight(.semibold))
                        Text("(\(agents.count))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        if runningCount > 0 {
                            Text("\(runningCount) active")
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
                        isFullscreen.toggle()
                    }
                } label: {
                    Image(systemName: isFullscreen
                          ? "arrow.down.right.and.arrow.up.left"
                          : "arrow.up.left.and.arrow.down.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)

            // MARK: Agent list (gated on isExpanded)
            //
            // Matches the pre-migration ConversationView+Agents.swift:61-118.
            // The frame(maxHeight:132) cap applies when not fullscreen.
            if isExpanded {
                let agentList = ScrollView {
                    VStack(spacing: 4) {
                        ForEach(agents) { agent in
                            AgentBarRow(
                                agent: agent,
                                isLoadingMessages: false,
                                onTap: onOpenDispatch != nil ? {
                                    guard let lastDispatch = agent.dispatches.last else { return }
                                    onOpenDispatch?(lastDispatch, agent)
                                } : nil
                            )
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                }

                if isFullscreen {
                    agentList
                } else {
                    agentList.frame(maxHeight: 132)
                }
            }
        }
    }
}
