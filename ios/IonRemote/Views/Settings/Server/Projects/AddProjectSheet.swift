import SwiftUI

/// Add project to one server: a folder already on it, a git URL to clone
/// onto it, or the projects the phone's other servers have that it lacks.
struct AddProjectSheet: View {
    let session: ServerAdminSession
    let projects: ProjectsAdminModel

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @State private var model: AddProjectModel

    init(session: ServerAdminSession, projects: ProjectsAdminModel) {
        self.session = session
        self.projects = projects
        _model = State(initialValue: AddProjectModel(
            serverId: session.serverId, serverLabel: session.serverLabel, client: session.client,
            baseDir: CloneBaseDirectory.read(serverId: session.serverId)
        ))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Source", selection: $model.source) {
                        Text("Folder").tag(AddProjectModel.Source.folder)
                        Text("Git URL").tag(AddProjectModel.Source.url)
                        Text("Other Server").tag(AddProjectModel.Source.copy)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    Text(sourceExplanation)
                }
                if let error = model.error {
                    Section { AdminErrorRow(message: error) }
                }
                if let reason = denial {
                    Section { Text(reason).foregroundStyle(.secondary) }
                } else {
                    switch model.source {
                    case .folder: folderSource
                    case .url: urlSource
                    case .copy: copySource
                    }
                }
            }
            .navigationTitle("Add Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { confirmButton }
            }
        }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }

    private var denial: String? {
        switch model.source {
        case .folder: return session.denialReason(.environmentProjectsAdd)
        case .url, .copy: return session.denialReason(.environmentProjectsClone)
        }
    }

    private var sourceExplanation: String {
        switch model.source {
        case .folder: return "Pick a checkout that is already on \(session.serverLabel)."
        case .url: return "Clone a repository onto \(session.serverLabel)."
        case .copy: return "Clone the projects your other servers have that \(session.serverLabel) does not."
        }
    }

    @ViewBuilder private var confirmButton: some View {
        switch model.source {
        case .folder:
            EmptyView()
        case .url:
            Button("Clone") { Task { await done(model.cloneURL()) } }
                .disabled(!model.canClone || denial != nil)
        case .copy:
            let count = model.ticked.count
            Button(count > 0 ? "Clone \(count)" : "Clone") { Task { await done(model.cloneTicked()) } }
                .disabled(model.busy || count == 0 || denial != nil)
        }
    }

    @ViewBuilder private var folderSource: some View {
        ServerFolderBrowser(session: session, initialPath: model.baseDir, pickLabel: "Add This Folder", disabled: model.busy) { path, _ in
            Task { await done(model.addFolder(path)) }
        }
    }

    @ViewBuilder private var urlSource: some View {
        Section {
            TextField("git@github.com:org/repo.git", text: $model.url)
                .font(.body.monospaced())
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { if model.canClone { Task { await done(model.cloneURL()) } } }
        } header: {
            Text("Repository URL")
        }
        Section {
            LabeledContent("Clones Into") {
                Text(model.clonePreview).font(.callout.monospaced()).multilineTextAlignment(.trailing)
            }
        } footer: {
            Text("Change the base folder for clones on the Projects page.")
        }
    }

    @ViewBuilder private var copySource: some View {
        Section {
            if let candidates = model.candidates {
                if candidates.isEmpty {
                    Text(otherSources.isEmpty
                         ? "This phone is paired with no other server."
                         : "Every project your other servers have is already on \(session.serverLabel).")
                        .foregroundStyle(.secondary)
                }
                ForEach(candidates) { candidate in
                    Button { model.toggle(candidate) } label: {
                        ProjectCopyCandidateRow(candidate: candidate, ticked: model.ticked.contains(candidate.remote))
                    }
                    .foregroundStyle(.primary)
                }
            } else {
                AdminLoadingRow(text: "Looking at your other servers…")
            }
        } header: {
            Text("Projects to Copy")
        } footer: {
            if !model.sourceFailures.isEmpty {
                Text("Could not list: \(model.sourceFailures.joined(separator: "; "))")
            } else {
                Text("Each clones into \(model.baseDir) on \(session.serverLabel).")
            }
        }
        .task { await model.loadCandidates(from: otherSources, existing: projects.projects ?? []) }
    }

    private var otherSources: [PairedServerSource] {
        PairedServerSource.others(than: session.serverId, in: viewModel)
    }

    private func done(_ succeeded: Bool) async {
        guard succeeded else { return }
        await projects.load()
        dismiss()
    }
}
