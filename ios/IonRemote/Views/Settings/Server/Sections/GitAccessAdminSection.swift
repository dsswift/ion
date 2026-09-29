import SwiftUI

/// The Git access section of a server: this person's credentials there (tap
/// for detail, swipe to remove), Add credential, Test access, and the host's
/// commit author.
struct GitAccessAdminSection: View {
    let session: ServerAdminSession

    @State private var model: GitAccessModel
    @State private var sheet: Sheet?
    @State private var pendingRemoval: GitIdentitySummary?
    @Environment(\.scenePhase) private var scenePhase

    private enum Sheet: String, Identifiable {
        case add, author
        var id: String { rawValue }
    }

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: GitAccessModel(session: session))
    }

    var body: some View {
        credentialRows
        if let error = model.operationError {
            AdminErrorRow(message: error)
        }
        // The section's loading and sheets hang off this row: it is always
        // present, so each attaches once rather than once per credential.
        Button("Add Credential") { sheet = .add }
            .disabled(!session.allows(.gitIdentityMintSshKey))
            .task { await model.load() }
            .reloadsWithServerPage("git-access") { [model] in await model.load() }
            // A sign-in finishes on the server while the phone is in Safari.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.loadIdentities() } }
            }
            .sheet(item: $sheet) { which in
                switch which {
                case .add: AddGitCredentialSheet(session: session) { Task { await model.loadIdentities() } }
                case .author: CommitAuthorSheet(session: session, access: model)
                }
            }
            .confirmationDialog(
                pendingRemoval.map { "Remove the credential for \($0.host)?" } ?? "",
                isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
                titleVisibility: .visible,
                presenting: pendingRemoval
            ) { identity in
                Button("Remove", role: .destructive) { Task { await model.remove(identity) } }
            } message: { identity in
                Text("\(session.serverLabel) stops using it for \(identity.host).")
            }
        if let reason = session.denialReason(.gitIdentityList) {
            Text(reason).font(.footnote).foregroundStyle(.secondary)
        }
        NavigationLink("Test Access") { GitTestAccessView(session: session) }
            .disabled(!session.allows(.environmentGitTest))
        Button { sheet = .author } label: {
            LabeledContent("Commit Author") { authorLabel }
        }
        .foregroundStyle(.primary)
        .disabled(model.author == nil)
    }

    @ViewBuilder private var credentialRows: some View {
        if let identities = model.identities {
            if identities.isEmpty {
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    Text("No credential stored in Ion")
                    Text(model.noCredentialExplanation).font(.footnote).foregroundStyle(.secondary)
                }
            }
            ForEach(identities) { identity in
                NavigationLink {
                    GitCredentialDetailView(session: session, model: model, identity: identity)
                } label: {
                    GitCredentialRow(identity: identity)
                }
                .swipeActions {
                    if GitIdentityLabels.isRemovable(identity) && session.allows(.gitIdentityRemove) {
                        Button("Remove", role: .destructive) { pendingRemoval = identity }
                    }
                }
            }
        } else if let error = model.identitiesError {
            AdminErrorRow(message: error)
        } else if session.allows(.gitIdentityList) {
            AdminLoadingRow(text: "Loading credentials…")
        }
    }

    @ViewBuilder private var authorLabel: some View {
        if let author = model.author {
            Text(author.isSet ? "\(author.name) <\(author.email)>" : "Not set").lineLimit(1).truncationMode(.middle)
        } else if model.authorError != nil {
            Text("Unavailable")
        } else {
            Text("Loading…")
        }
    }
}
