import SwiftUI

/// Edit the commit author on one server, or copy it from another paired server.
struct CommitAuthorSheet: View {
    let session: ServerAdminSession
    let access: GitAccessModel

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @State private var model: CommitAuthorModel

    init(session: ServerAdminSession, access: GitAccessModel) {
        self.session = session
        self.access = access
        _model = State(initialValue: CommitAuthorModel(serverId: session.serverId, current: access.author))
    }

    var body: some View {
        let sources = PairedServerSource.others(than: session.serverId, in: viewModel)
        NavigationStack {
            List {
                if let error = model.error {
                    Section { AdminErrorRow(message: error) }
                }
                Section {
                    TextField("Name", text: $model.name)
                        .textContentType(.name)
                    TextField("email@example.org", text: $model.email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text(session.denialReason(.environmentGitAuthorSet) ?? "The global git name and email on \(session.serverLabel).")
                }
                if !sources.isEmpty {
                    Section {
                        Menu {
                            ForEach(sources, id: \.serverId) { source in
                                Button(source.label) { Task { await model.copy(from: source) } }
                            }
                        } label: {
                            Label("Copy from Another Server", systemImage: "doc.on.doc")
                        }
                        .disabled(model.busy)
                    }
                }
            }
            .navigationTitle("Commit Author")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await access.saveAuthor(model.draft) { dismiss() } else { model.setError(access.authorError) }
                        }
                    }
                    .disabled(!model.canSave || !session.allows(.environmentGitAuthorSet))
                }
            }
        }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }
}
