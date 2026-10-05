import SwiftUI

// MARK: - ConversationView layout sub-views
//
// The merged ConversationView (#256) composes its `body` from a chain of
// view-builder sub-views (header, main content, footer, toolbar, themed
// background). Extracted here to keep ConversationView.swift under the 600-line
// cap and to leave headroom for the conversation-surface rebuild, mirroring the
// +InputBar / +Agents / +Presentation splits already in this folder. These are
// `internal` (not `private`) because `body` in ConversationView.swift and the
// sub-views themselves reference each other across the file boundary — Swift
// `private` is file-scoped, so the extracted members must be internal to stay
// reachable from the host file.

extension ConversationView {

    /// Above the transcript. Only a legacy multi-instance snapshot puts
    /// anything here; context occupancy lives in the composer's ring and live
    /// progress in the activity strip above the composer, so a single-instance
    /// conversation starts directly with its transcript.
    @ViewBuilder
    var headerSection: some View {
        if instances.count > 1 {
            EngineInstanceBar(
                tabId: tabId,
                instances: instances,
                activeInstanceId: activeInstanceId
            )
        }
    }

    var footerSection: some View {
        // The keyboard utility bar — its `@State keyboardVisible`, the
        // keyboard-show/hide observers, and the animation modifier all
        // live inside EngineKeyboardUtilityBarOverlay (sibling file).
        // The host only forwards the user's toggle preference and the
        // two action bindings (dismiss + draft text) the bar needs.
        VStack(spacing: 0) {
            // What the conversation is doing, resolved from the signals the
            // snapshot reliably carries (the same resolver the tests pin). The
            // extension name rides along from the status fields: a plain
            // conversation carries none and shows none, by absence of data
            // rather than a tab-type branch.
            let activeInst = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)
            ConversationActivityStrip(
                activity: ConversationStatusBar.resolveRunActivity(
                    isRunning: isRunning,
                    runningAgentCount: runningAgentCount,
                    runningShellCount: runningShellCount
                ),
                workingMessage: viewModel.workingMessage(tabId),
                extensionName: activeInst?.statusFields?.extensionName
            )
            // The composer renders for every conversation state. A fresh
            // engine instance with no status yet still gets its model picker,
            // mode control, and a neutral context ring; the status-dependent
            // values resolve nil-safely inside ConversationStatusBar.
            engineInputBar
        }
        .engineKeyboardUtilityBar(
            isEnabled: viewModel.showKeyboardUtilityBar,
            onDismiss: { isInputFocused = false },
            promptText: promptTextBinding
        )
    }

    /// RC-18: failed-load banner with an explicit retry. Shown by mainContent
    /// when the transcript is empty and the load failed (both timer retries
    /// expired). Replaces the previously-silent blank transcript.
    var conversationLoadFailedBanner: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                .font(.system(size: 28)) // design-type: SF Symbol empty-state glyph sized as icon geometry, not text
                .foregroundStyle(.secondary)
            Text("Couldn't load this conversation")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                viewModel.loadConversation(tabId: tabId)
            } label: {
                Label("Reload", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, IonSpace.screenInset)
    }

    var mainContent: some View {
        VStack(spacing: 0) {
            headerSection
            let transcriptView = Transcript(
                messages: engineMsgs,
                unifiedTurnView: unifiedTurnView,
                pinnedPrompt: viewModel.enginePinnedPrompt[compoundKey],
                isRunning: isRunning,
                runDurationMs: viewModel.tab(for: tabId)?.lastRunDurationMs,
                runCompletionReason: viewModel.tab(for: tabId)?.lastRunReason,
                onRewind: { messageId in
                    viewModel.engineRewindInstance(
                        tabId: tabId,
                        instanceId: activeInstanceId,
                        messageId: messageId
                    )
                },
                onFork: { messageId in
                    viewModel.forkFromMessage(tabId: tabId, messageId: messageId)
                },
                agents: visibleAgents.isEmpty ? nil : visibleAgents,
                allAgents: allAgents,
                onOpenDispatch: { dispatch, agent in
                    selectedDispatchId = dispatch.id
                },
                tabId: tabId,
                activeBackgroundTasks: activeBackgroundTasks,
                isNearBottom: $isNearBottom,
                forceScrollCounter: forceScrollCounter,
                jumpRequest: transcriptJumpRequest,
                onTapPlan: { path in
                    selectedPlanPath = IdentifiablePath(path: path)
                },
                onOpenFile: { path in handleFileLink(path, .open) },
                onReachedTop: {
                    // RC-15: page in older history when the user scrolls to the
                    // top. loadMoreMessages guards on hasMore + a stored cursor +
                    // no in-flight load, so this is a safe no-op when there is
                    // nothing older to fetch or a load is already running.
                    viewModel.loadMoreMessages(tabId: tabId)
                },
                agentPanelExpanded: agentsPanelExpandedBinding,
                agentPanelFullscreen: $agentPanelFullscreen
            )
            if !agentPanelFullscreen {
                transcriptView
            } else {
                transcriptView
                    .frame(height: 100)
            }

            // RC-18: a failed history load must be user-visible with a retry, not
            // a silently-blank transcript. conversationLoadFailed was written but
            // never read; surface it here when the transcript is empty (a failed
            // load with existing messages keeps showing them). loadingConversation
            // shows a spinner distinct from the empty state so "loading" never
            // looks like "zero messages".
            if engineMsgs.isEmpty {
                if viewModel.conversationLoadFailed.contains(tabId) {
                    conversationLoadFailedBanner
                } else if viewModel.loadingConversation.contains(tabId) {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading conversation…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, IonSpace.sectionGap)
                }
            }

            if let request = pendingPermission {
                if PlanCardGate.shouldShowCard(toolName: request.toolName, runningAgentCount: runningAgentCount) {
                    PermissionCardView(tabId: tabId, request: request)
                        .padding(.horizontal, IonSpace.rowInset)
                        .padding(.vertical, IonSpace.compactGap)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    // Plan Ready card deferred while a background dispatch is
                    // still running — the orchestrator will resume and revise the
                    // plan once the dispatch reports back. The card returns once
                    // the dispatch ends (the denial is not cleared, only hidden).
                    let _ = DiagnosticLog.log("deferring plan ready card", tag: "view.plancard", fields: [
                        "tab_id": String(tabId.prefix(8)),
                        "count": String(runningAgentCount)
                    ])
                }
            }

            if let elicitation = pendingElicitation {
                ElicitationCardView(tabId: tabId, request: elicitation)
                    .padding(.horizontal, IonSpace.rowInset)
                    .padding(.vertical, IonSpace.compactGap)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Guided Questions: collapsed card is the wizard's entry point.
            // Never in permissionQueue — its own synchronized store drives it.
            if let questionsWorkflow = viewModel.questionsStore.currentWorkflow(tabId: tabId) {
                QuestionsCardView(
                    tabId: tabId,
                    workflow: questionsWorkflow,
                    queuedCount: viewModel.questionsStore.openWorkflows(tabId: tabId).count - 1
                )
                .padding(.horizontal, IonSpace.rowInset)
                .padding(.vertical, IonSpace.compactGap)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            footerSection
        }
    }

    /// Two toolbar items: the conversation's attachments, which carry their
    /// count, and one menu for the developer surfaces (files, git, terminal)
    /// and the status drawer. Three accent glyphs in a row competed with the
    /// title and read as three equal priorities; the menu keeps them one tap
    /// away without claiming the bar.
    var toolbarButtons: some View {
        HStack(spacing: IonSpace.contentGap) {
            Button { showAttachments = true } label: {
                HStack(spacing: 2) { // design-geometry: 2pt gap between a glyph and its count; below the 4pt rhythm floor
                    Image(systemName: "paperclip")
                    if engineAttachmentCount > 0 {
                        Text("\(engineAttachmentCount)")
                            .font(IonType.microLabel)
                    }
                }
                .foregroundStyle(engineAttachmentCount > 0 ? theme.accent : theme.textSecondary)
            }
            .accessibilityLabel(engineAttachmentCount > 0
                ? "Attachments, \(engineAttachmentCount)"
                : "Attachments")

            Menu {
                Button { showFileExplorer = true } label: {
                    Label("Files", systemImage: "folder")
                }
                // Absent where the server offers neither the changes list nor the graph.
                if viewModel.developerSurfaces.gitPaneOffered {
                    Button { showGitPane = true } label: {
                        Label("Changes", systemImage: "arrow.triangle.branch")
                    }
                }
                Button { showTerminal = true } label: {
                    Label("Terminal", systemImage: "terminal")
                }
                // Only once a rewind has left another path to go back to.
                if branchCount > 1 {
                    Button { showBranches = true } label: {
                        Label("Branches (\(branchCount))", systemImage: "signpost.right.and.left")
                    }
                }
                Divider()
                Button { showStatusDrawer = true } label: {
                    Label("Conversation status", systemImage: "gauge.with.dots.needle.33percent")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(theme.textSecondary)
            }
            .accessibilityLabel("More")
        }
    }

    var themedBackground: some View {
        ZStack {
            theme.background
            if let bg = theme.backgroundView {
                bg.opacity(0.35)
            }
        }
        .ignoresSafeArea()
    }

    var styledMainContent: some View {
        mainContent
            .background(themedBackground)
            .toolbarBackground(theme.background.opacity(0.95), for: .navigationBar)
            .toolbarColorScheme(theme.backgroundView != nil ? .dark : nil, for: .navigationBar)
    }
}
