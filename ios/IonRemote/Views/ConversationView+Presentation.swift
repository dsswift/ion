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
            .fullScreenCover(isPresented: $showFileExplorer) {
                FileExplorerView(tabId: tabId)
                    .environment(viewModel)
            }
            .fullScreenCover(isPresented: Binding(
                get: { selectedDispatchId != nil },
                set: { if !$0 { selectedDispatchId = nil } }
            )) {
                if let dispatchId = selectedDispatchId,
                   let agent = visibleAgents.first(where: { $0.dispatches.contains(where: { $0.id == dispatchId }) }) {
                    AgentDetailFullScreenView(
                        dispatchId: dispatchId,
                        agentName: agent.name,
                        compoundKey: compoundKey
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
                ConversationAttachmentsSheet(tabId: tabId)
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
            .animation(.default, value: pendingPermission?.id)
    }
}
