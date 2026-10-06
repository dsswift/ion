import SwiftUI

/// The New Project card, offered from New Conversation: name a repository,
/// say what to build, pick the model, and the connected server creates the
/// repository, clones it, opens a conversation in it, and sends the prompt.
/// The card may close while that runs; the server finishes on its own.
struct NewProjectSheet: View {
    let session: ServerAdminSession
    /// The conversation the server opened, once the project is done.
    let onOpened: (_ tabId: String) -> Void

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: NewProjectModel
    @State private var showModelPicker = false
    /// The running create, followed while the card is open and dropped when it closes.
    @State private var running: Task<Void, Never>?

    init(session: ServerAdminSession, onOpened: @escaping (_ tabId: String) -> Void) {
        self.session = session
        self.onOpened = onOpened
        _model = State(initialValue: NewProjectModel(
            serverId: session.serverId, serverLabel: session.serverLabel, client: session.client,
            baseDir: CloneBaseDirectory.read(serverId: session.serverId)
        ))
    }

    var body: some View {
        NavigationStack {
            List {
                if let error = model.error ?? model.repository.error {
                    Section { AdminErrorRow(message: error) }
                }
                if let denial {
                    Section { Text(denial).foregroundStyle(.secondary) }
                } else {
                    NewRepositorySource(model: model.repository)
                        .disabled(model.busy)
                    promptSection
                    conversationSection
                    if let progress = model.progress {
                        Section {
                            AdminLoadingRow(text: progress)
                        } footer: {
                            Text("You can close this. \(session.serverLabel) finishes on its own, and the conversation appears in your list.")
                        }
                    }
                }
            }
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(model.busy ? "Close" : "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.error == nil ? "Create" : "Retry") { running = Task { await start() } }
                        .disabled(!model.canStart || denial != nil)
                }
            }
            .sheet(isPresented: $showModelPicker) {
                ModelPickerSheet(
                    models: viewModel.availableModels,
                    selectedModelId: model.effectiveModelId,
                    preferredModelId: model.defaultModelId,
                    inheritOption: .init(label: "Server Default", value: ""),
                    onSelect: { modelId, providerId in model.pickModel(modelId, providerId: providerId) }
                )
            }
        }
        .onAppear {
            session.open()
            model.profileId = initialProfileId
        }
        .onDisappear {
            // The server carries on; only the following stops, so a project
            // that finishes later never pulls the screen to its conversation.
            running?.cancel()
            session.close()
        }
        .task { await model.loadDefaults() }
        .onChange(of: scenePhase) { _, phase in
            // Job events sent while the app slept were missed; read the job again.
            if phase == .active { Task { await model.resync() } }
        }
    }

    private var denial: String? {
        session.denialReason(.gitHostingStartProject) ?? session.denialReason(scope: .conversationsOperate)
    }

    @ViewBuilder private var promptSection: some View {
        Section {
            TextField("What should the agent start on?", text: $model.prompt, axis: .vertical)
                .lineLimit(4...12)
        } header: {
            Text("Opening Prompt")
        } footer: {
            Text("Sent as the conversation's first message. Leave it empty to open the conversation without one.")
        }
        .disabled(model.busy)
    }

    @ViewBuilder private var conversationSection: some View {
        Section {
            Button { showModelPicker = true } label: {
                LabeledContent("Model") {
                    Text(modelLabel).foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(.primary)
            if showsProfilePicker {
                Picker("Harness", selection: $model.profileId) {
                    Text("Plain").tag(String?.none)
                    ForEach(viewModel.engineProfiles) { profile in
                        Text(profile.name).tag(String?.some(profile.id))
                    }
                }
            }
        } header: {
            Text("Conversation")
        }
        .disabled(model.busy)
    }

    /// The model's name, or the default's marked as such.
    private var modelLabel: String {
        let id = model.effectiveModelId
        let name = ModelCatalog.entry(for: id, in: viewModel.availableModels)?.label ?? (id.isEmpty ? "Server default" : id)
        return model.modelId == nil && !id.isEmpty ? "\(name) (default)" : name
    }

    /// A harness is chosen here unless the server mandates one or offers none.
    private var showsProfilePicker: Bool {
        !viewModel.engineProfiles.isEmpty && viewModel.enterpriseNewConversationPolicy?.locked != true
    }

    /// The harness a new conversation gets on this server without asking.
    private var initialProfileId: String? {
        let policy = viewModel.enterpriseNewConversationPolicy.map {
            NewConversationDefaultsPolicy(locked: $0.locked, baseDirectory: $0.baseDirectory, profileId: $0.engineProfileId)
        }
        switch resolveNewConversationAction(profiles: viewModel.engineProfiles, defaultId: viewModel.defaultEngineProfileId, enterprisePolicy: policy) {
        case .profile(let profileId): return profileId
        case .locked(_, let profileId): return profileId.isEmpty ? nil : profileId
        case .plain, .showPicker: return nil
        }
    }

    private func start() async {
        guard let tabId = await model.start(), !Task.isCancelled else { return }
        onOpened(tabId)
        dismiss()
    }
}
