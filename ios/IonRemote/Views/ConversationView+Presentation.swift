import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// MARK: - ConversationView presentation layers
//
// The merged ConversationView (#256) presents many sheets, full-screen covers,
// pickers, and onChange handlers. Applying them all in one inline modifier
// chain in `body` exceeded the Swift type-checker's complexity budget, so they
// are split into two halves here and applied via ConversationPresentationLayers.
// Each method takes the content and returns it with roughly half the modifiers
// attached, keeping every sub-chain small enough to type-check quickly.

extension ConversationView {

    @ViewBuilder
    func presentationLayersA<C: View>(_ content: C) -> some View {
        content
            .sheet(item: Binding(
                get: { viewModel.engineDialogs[compoundKey] ?? nil },
                set: { _ in }
            )) { dialog in
                EngineDialogSheet(tabId: tabId, dialog: dialog)
            }
            // Status drawer (ⓘ toolbar button). Step 8 — plan modest-leaping-waffle.
            .sheet(isPresented: $showStatusDrawer) {
                StatusDrawerView(
                    tabId: tabId,
                    compoundKey: compoundKey,
                    fields: viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)?.statusFields,
                    agents: visibleAgents,
                    activeTools: activeToolsList,
                    onOpenDispatch: { dispatchId in
                        // Deep-link: open the specific dispatch via pendingDispatchId
                        // so ConversationView's onChange reconstructs the breadcrumb chain.
                        showStatusDrawer = false
                        viewModel.pendingDispatchId = dispatchId
                    }
                )
                .environment(viewModel)
            }
            .fullScreenCover(isPresented: $showGitPane) {
                GitPaneView(tabId: tabId)
                    .environment(viewModel)
            }
            .fullScreenCover(isPresented: $showTerminal) {
                ConversationTerminalView(tabId: tabId)
                    .environment(viewModel)
            }
            .onChange(of: viewModel.pendingGitPaneTabId) { _, newId in
                if newId == tabId {
                    viewModel.pendingGitPaneTabId = nil
                    showGitPane = true
                }
            }
            // Step 9a: pendingDispatchId deep-link. When the drawer (or a future
            // push notification) sets pendingDispatchId, open AgentDetailFullScreenView
            // for that specific dispatch with the ancestor breadcrumb pre-populated.
            .onChange(of: viewModel.pendingDispatchId) { _, newId in
                guard let dispatchId = newId else { return }
                // Find the agent that owns this dispatch across all visible agents
                // (all tiers — agentStates is flat across all depths).
                let allAgents = viewModel.engineInstance(tabId: tabId, instanceId: nil)?.agentStates ?? []
                let ownerAgent = allAgents.first(where: { agent in
                    agent.dispatches.contains(where: { $0.id == dispatchId })
                })
                if ownerAgent != nil {
                    viewModel.pendingDispatchId = nil
                    selectedDispatchId = dispatchId
                } else {
                    // Agent not found (may have ended): clear the pending id silently.
                    viewModel.pendingDispatchId = nil
                }
            }
            .fullScreenCover(isPresented: $showFileExplorer) {
                FileExplorerView(tabId: tabId)
                    .environment(viewModel)
            }
            .fullScreenCover(isPresented: Binding(
                get: { selectedDispatchId != nil },
                set: { if !$0 { selectedDispatchId = nil } }
            )) {
                if let dispatchId = selectedDispatchId {
                    // Step 9a: reconstruct the full ancestor breadcrumb chain before
                    // presenting. Walk dispatchParentId up through durable agentStates
                    // to build the root → ... → target BreadcrumbEntry[] for the
                    // NavigationStack's initial path. This is the symmetric iOS fix for
                    // the desktop's buildBreadcrumbStack (agent-panel-helpers.ts). The
                    // AgentDetailFullScreenView receives the full stack via initialPath
                    // so the user sees the correct breadcrumb bar from the first frame
                    // rather than an empty stack that requires manual drill-down.
                    let allAgents = viewModel.engineInstance(tabId: tabId, instanceId: nil)?.agentStates ?? []
                    let targetAgent = allAgents.first(where: { a in
                        a.dispatches.contains(where: { $0.id == dispatchId })
                    })
                    AgentDetailFullScreenView(
                        dispatchId: dispatchId,
                        agentName: targetAgent?.name ?? "",
                        compoundKey: compoundKey,
                        initialAncestorPath: buildBreadcrumbPath(
                            dispatchId: dispatchId,
                            allAgents: allAgents
                        )
                    )
                    .environment(viewModel)
                }
            }
            // Plan-preview cover, opened when the user taps a plan-lifecycle
            // divider's slug link. Mirrors the attachment-drawer plan-open
            // path (ConversationAttachmentsSheet): PlanContentView loads the
            // body via requestFsReadFile and renders PlanFullScreenView.
            .fullScreenCover(item: $selectedPlanPath) { item in
                PlanContentView(path: item.path)
                    .environment(viewModel)
            }
            // File-preview cover, opened when the user taps a file-path chip
            // (an ion-file:// link) in assistant markdown. Mirrors the
            // plan-preview path above.
            .fullScreenCover(item: $selectedFilePath) { item in
                NavigationStack {
                    FileEditorView(
                        filePath: item.path,
                        fileName: (item.path as NSString).lastPathComponent
                    )
                    .environment(viewModel)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { selectedFilePath = nil }
                        }
                    }
                }
            }
    }

    /// Resolve a tapped `ion-file://` path and present the file preview.
    /// Relative paths resolve against the tab's working directory; absolute
    /// paths pass through. Lives here (not ConversationView.swift) with the
    /// cover it drives, keeping the main file under the size cap.
    func openFilePreview(_ path: String) {
        let resolved = path.hasPrefix("/")
            ? path
            : (workingDirectory as NSString).appendingPathComponent(path)
        selectedFilePath = IdentifiablePath(path: resolved)
    }

    @ViewBuilder
    func presentationLayersB<C: View>(_ content: C) -> some View {
        content
            .sheet(isPresented: $showFilePicker) {
                FilePickerSheet(initialDirectory: workingDirectory) { path, name in
                    addFileAttachment(path: path, name: name)
                }
                .environment(viewModel)
            }
            .sheet(isPresented: $showAttachments) {
                ConversationAttachmentsSheet(tabId: tabId, onJumpToRow: requestTranscriptJump)
                    .environment(viewModel)
            }
            .onChange(of: viewModel.pendingUploadResults) { _, results in
                consumeUploadResults(results)
            }
            .onChange(of: photosPickerItems) { _, items in
                for item in items { handlePhotoSelection(item) }
                photosPickerItems = []
            }
            .onChange(of: viewModel.connectionState) { oldState, newState in
                handleConnectionStateChange(oldState: oldState, newState: newState)
            }
            .onChange(of: engineMsgs.count) {
                consumePendingScrollAfterReload()
            }
            .photosPicker(
                isPresented: $showPhotoPicker,
                selection: $photosPickerItems,
                maxSelectionCount: 5,
                matching: .images
            )
            .fileImporter(
                isPresented: $showDocumentPicker,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                handleDocumentPickerResult(result)
            }
            .confirmationDialog("Attach", isPresented: $showAttachMenu) {
                Button("Photo Library") { showPhotoPicker = true }
                Button("Choose File") { showDocumentPicker = true }
                Button("Browse Desktop Files") { showFilePicker = true }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                "Clear the conversation first?",
                isPresented: Binding(
                    get: { pendingClearingCommand != nil },
                    set: { if !$0 { pendingClearingCommand = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Clear and run", role: .destructive) {
                    pendingClearingCommand = nil
                    submitPrompt(skipClearConfirm: true)
                }
                Button("Cancel", role: .cancel) {
                    DiagnosticLog.log(
                        "clearing command: operator declined",
                        tag: "session",
                        level: .info,
                        fields: ["command": pendingClearingCommand?.command ?? ""]
                    )
                    pendingClearingCommand = nil
                }
            } message: {
                if let pending = pendingClearingCommand {
                    Text(ClearingCommand.message(for: pending.command))
                }
            }
            .animation(.default, value: pendingPermission?.id)
    }

    // MARK: - Breadcrumb chain reconstruction (Step 9a)
    //
    // Given a target dispatchId, walks the dispatchParentId chain through durable
    // agentStates to build the full ancestor BreadcrumbEntry[] from root → target.
    // This is the iOS symmetric of desktop's buildBreadcrumbStack in
    // agent-panel-helpers.ts.
    //
    // The result is passed to AgentDetailFullScreenView as `initialAncestorPath`
    // so the NavigationStack's initial path includes all intermediate frames from
    // the first frame, not just the root. Without this, a tier-3+ dispatch opened
    // from the drawer would show only the root frame and the user would need to
    // manually drill down to reach the target dispatch.
    //
    // Algorithm:
    //   1. Find the target dispatch by id across all agentStates.
    //   2. Walk dispatchParentId up through agentStates, building the ancestor chain.
    //   3. Return the chain minus the root (the root is shown by AgentDetailFullScreenView
    //      itself; the initialAncestorPath contains only the intermediate + target frames).
    func buildBreadcrumbPath(
        dispatchId: String,
        allAgents: [AgentStateUpdate]
    ) -> [BreadcrumbEntry] {
        // Build a map from dispatchId -> (agent, dispatchInfo) for O(1) lookup.
        var dispatchMap: [String: (AgentStateUpdate, DispatchInfo)] = [:]
        for agent in allAgents {
            for dispatch in agent.dispatches {
                dispatchMap[dispatch.id] = (agent, dispatch)
            }
        }

        guard let (_, targetDispatch) = dispatchMap[dispatchId] else { return [] }

        // Walk the chain from target up to the root, collecting entries.
        var chain: [BreadcrumbEntry] = []
        var currentDispatchId = dispatchId

        // Safety: cap at 20 levels to prevent infinite loops from bad data.
        var iterations = 0
        while !currentDispatchId.isEmpty, iterations < 20 {
            iterations += 1
            guard let (agent, dispatch) = dispatchMap[currentDispatchId] else { break }
            chain.append(BreadcrumbEntry(
                agentName: agent.name,
                displayName: agent.displayName,
                conversationId: dispatch.conversationId,
                dispatchId: dispatch.id
            ))
            // Walk to parent.
            let parentId = agent.dispatchParentId
            if parentId.isEmpty { break }
            // Find the dispatch whose id equals parentId.
            currentDispatchId = parentId
        }

        // Reverse so the chain is root → ... → target.
        // Drop the first entry (root) since AgentDetailFullScreenView shows the root itself.
        // The remaining entries are the intermediate + target frames pushed into the path.
        let ordered = chain.reversed()
        // `ordered` is root...target. The root (first) is already the AgentDetailFullScreenView
        // top-level; we only push the intermediate + target as path entries.
        return Array(ordered.dropFirst())
    }
}
