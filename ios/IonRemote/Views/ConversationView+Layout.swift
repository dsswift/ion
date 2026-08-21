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

    var headerSection: some View {
        VStack(spacing: 0) {
            ConversationContextStrip(
                statusFields: viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)?.statusFields,
                modelOverride: viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)?.modelOverride,
                preferredModel: viewModel.preferredModel,
                availableModels: viewModel.availableModels,
            )

            if instances.count > 1 {
                EngineInstanceBar(
                    tabId: tabId,
                    instances: instances,
                    activeInstanceId: activeInstanceId
                )
            }

            let working = viewModel.workingMessage(tabId)
            if !working.isEmpty {
                HStack {
                    ProgressView()
                        .scaleEffect(0.7)
                    Text(working)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, IonSpace.contentGap)
                .padding(.vertical, IonSpace.compactInset)
                .background(Capsule().fill(Color(.tertiarySystemFill)))
                .padding(.horizontal, IonSpace.contentGap)
                .padding(.vertical, IonSpace.hairlineGap)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    var footerSection: some View {
        // The keyboard utility bar — its `@State keyboardVisible`, the
        // keyboard-show/hide observers, and the animation modifier all
        // live inside EngineKeyboardUtilityBarOverlay (sibling file).
        // The host only forwards the user's toggle preference and the
        // two action bindings (dismiss + draft text) the bar needs.
        VStack(spacing: 0) {
            Divider()
            // The status bar must ALWAYS be visible for engine tabs, exactly as
            // it is for plain conversations (ConversationView renders it
            // unconditionally). Previously this was gated on
            // `statusFields != nil`, so a fresh engine instance (no status yet)
            // showed no bar at all — the model picker, permission toggle, and
            // attachments button vanished. Render the bar always and derive the
            // status-dependent values nil-safely from the optional fields: the
            // status dot / context% / extension name self-hide inside the
            // component when their inputs are absent.
            let activeInst = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)
            let engineInputs = ConversationStatusBar.resolveEngineInputs(
                fields: activeInst?.statusFields,
                fallbackPreferredModel: viewModel.preferredModel,
            )
            ConversationStatusBar(
                modelOverride: activeInst?.modelOverride,
                preferredModel: engineInputs.preferredModel,
                contextPercent: engineInputs.contextPercent,
                contextTokens: engineInputs.contextTokens,
                engineContextWindow: engineInputs.engineContextWindow,
                isRunning: isRunning,
                permissionMode: viewModel.tab(for: tabId)?.permissionMode,
                availableModels: viewModel.availableModels,
                attachmentCount: engineAttachmentCount,
                onSelectModel: { model in
                    viewModel.setModel(tabId: tabId, model: model)
                },
                onToggleMode: {
                    guard let current = viewModel.tab(for: tabId)?.permissionMode else { return }
                    let newMode: PermissionMode = current == .plan ? .auto : .plan
                    viewModel.setPermissionMode(tabId: tabId, mode: newMode)
                },
                onTapAttachments: {
                    showAttachments = true
                },
                onTapContextIndicator: {
                    showStatusDrawer = true
                },
                hasEngineExtension: tabHasExtensions,
                // DATA-driven (#256 follow-up): pass the harness/extension name
                // straight through. The status bar renders the badge iff the
                // name is non-nil/non-empty, so a plain conversation (whose
                // status fields carry no extensionName) simply shows no badge —
                // by absence of data, not a tab-type branch. The former
                // `tabHasExtensions ? … : nil` gate was an illegitimate fork.
                extensionName: engineInputs.extensionName,
                runningAgentCount: runningAgentCount,
                thinkingEffort: activeInst?.thinkingEffort ?? "off",
                onSelectThinkingEffort: { level in
                    viewModel.setThinkingEffort(tabId: tabId, effort: level)
                }
            )
            Divider()
            if !pendingAttachments.isEmpty {
                AttachmentChipsView(attachments: pendingAttachments) { id in
                    pendingAttachments.removeAll { $0.id == id }
                }
            }
            engineInputBar
        }
        .engineKeyboardUtilityBar(
            isEnabled: viewModel.showKeyboardUtilityBarInEngine,
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
                isNearBottom: $isNearBottom,
                forceScrollCounter: forceScrollCounter,
                onTapPlan: { path in
                    selectedPlanPath = IdentifiablePath(path: path)
                },
                onOpenFile: { path in openFilePreview(path) },
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

            footerSection
        }
    }

    var toolbarButtons: some View {
        HStack(spacing: 12) {
            Button { showFileExplorer = true } label: {
                Image(systemName: "folder")
                    .font(.subheadline)
                    .foregroundStyle(theme.accent)
            }
            Button { showGitPane = true } label: {
                Image(systemName: "arrow.triangle.branch")
                    .font(.subheadline)
                    .foregroundStyle(theme.accent)
            }
            Button { showTerminal = true } label: {
                Image(systemName: "terminal")
                    .font(.subheadline)
                    .foregroundStyle(theme.accent)
            }
            // Add-instance button removed in #256 (single-instance collapse).
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
