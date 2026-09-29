import SwiftUI

/// Add a git credential on one server, or connect through the git host's
/// sign-in. A minted or pasted key ends on its public half, to add on the
/// git host.
struct AddGitCredentialSheet: View {
    let session: ServerAdminSession
    let onAdded: () -> Void

    @State private var model: AddGitCredentialModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    init(session: ServerAdminSession, onAdded: @escaping () -> Void) {
        self.session = session
        self.onAdded = onAdded
        _model = State(initialValue: AddGitCredentialModel(serverId: session.serverId, serverLabel: session.serverLabel, client: session.client))
    }

    var body: some View {
        NavigationStack {
            List {
                if let minted = model.minted {
                    Section {
                        GitPublicKeyRows(host: minted.host, publicKey: minted.publicKey)
                    } header: {
                        Text("Public Key")
                    } footer: {
                        Text("\(session.serverLabel) now holds a key for \(minted.host). Add this public key to your account there, then test access.")
                    }
                } else {
                    form
                }
            }
            .navigationTitle("Add Credential")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if model.minted != nil {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        } else {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(model.busy ? "Adding…" : "Add") {
                    Task {
                        let closes = await model.submit()
                        if model.error == nil { onAdded() }
                        if closes { dismiss() }
                    }
                }
                .disabled(!model.canSubmit || !session.allows(requiredAction))
            }
        }
    }

    private var requiredAction: PhoneAction {
        switch model.mode {
        case .mint: return .gitIdentityMintSshKey
        case .pasteKey: return .gitIdentitySetSshKey
        case .token: return .gitIdentitySetToken
        }
    }

    @ViewBuilder private var form: some View {
        if let error = model.error {
            Section { AdminErrorRow(message: error) }
        }
        if let reason = session.denialReason(requiredAction) {
            Section { Text(reason).foregroundStyle(.secondary) }
        }
        Section {
            TextField("github.com", text: $model.host)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } header: {
            Text("Git Host")
        } footer: {
            Text("Stored on \(session.serverLabel) and used for every repository on that host.")
        }
        Section {
            Picker("Credential", selection: $model.mode) {
                Text("Mint Key").tag(AddGitCredentialModel.Mode.mint)
                Text("Paste Key").tag(AddGitCredentialModel.Mode.pasteKey)
                Text("Token").tag(AddGitCredentialModel.Mode.token)
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } footer: {
            Text(modeExplanation)
        }
        switch model.mode {
        case .mint:
            EmptyView()
        case .pasteKey:
            Section("SSH Private Key") {
                TextEditor(text: $model.pastedKey)
                    .font(.caption.monospaced())
                    .frame(minHeight: 140)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        case .token:
            Section {
                SecureField("Access token", text: $model.token)
                TextField("Username (optional)", text: $model.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } footer: {
                Text("Some hosts need a username with a token.")
            }
        }
        Section {
            Button("Connect via Sign-In") {
                Task {
                    guard let url = await model.authorize() else { return }
                    openURL(url)
                    dismiss()
                }
            }
            .disabled(model.busy || model.trimmedHost.isEmpty || !session.allows(.gitIdentityAuthorize))
        } footer: {
            Text("Sign in through \(session.serverLabel)'s GitHub or GitLab app instead of a key. The sign-in finishes on the server; the list updates when you come back.")
        }
    }

    private var modeExplanation: String {
        let gitHost = model.trimmedHost.isEmpty ? "the git host" : model.trimmedHost
        switch model.mode {
        case .mint: return "\(session.serverLabel) makes a new key pair. You add its public key to your account on \(gitHost)."
        case .pasteKey: return "Paste a private key that already has access to \(gitHost)."
        case .token: return "A personal access token for \(gitHost)."
        }
    }
}
