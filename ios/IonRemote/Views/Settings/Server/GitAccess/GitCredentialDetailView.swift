import SwiftUI

/// One git credential this person has on a server: its host, kind, where it
/// came from, and for a key its public half.
struct GitCredentialDetailView: View {
    let session: ServerAdminSession
    let model: GitAccessModel
    let identity: GitIdentitySummary

    @State private var confirmRemove = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if let error = model.operationError {
                Section { AdminErrorRow(message: error) }
            }
            Section {
                LabeledContent("Host", value: identity.host)
                LabeledContent("Kind", value: GitIdentityLabels.kind(identity.kind))
                LabeledContent("Source", value: GitIdentityLabels.source(identity.source))
                if let username = identity.username, !username.isEmpty {
                    LabeledContent("Username", value: username)
                }
            }
            if let publicKey = identity.publicKey, !publicKey.isEmpty {
                Section {
                    GitPublicKeyRows(host: identity.host, publicKey: publicKey)
                } header: {
                    Text("Public Key")
                } footer: {
                    Text("Add this key to your account on \(identity.host) so \(session.serverLabel) can reach your repositories.")
                }
            }
            if GitIdentityLabels.isRemovable(identity) {
                Section {
                    Button("Remove Credential", role: .destructive) { confirmRemove = true }
                        .disabled(model.removingHost != nil || !session.allows(.gitIdentityRemove))
                } footer: {
                    if let reason = session.denialReason(.gitIdentityRemove) { Text(reason) }
                }
            }
        }
        .navigationTitle(identity.host)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Remove the credential for \(identity.host)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task {
                    await model.remove(identity)
                    if model.operationError == nil { dismiss() }
                }
            }
        } message: {
            Text("\(session.serverLabel) stops using it for \(identity.host).")
        }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }
}
