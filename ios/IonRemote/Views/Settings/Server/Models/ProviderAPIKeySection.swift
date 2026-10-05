import SwiftUI

/// A provider's API key on the server: enter one, change or remove a saved
/// one, or add one on top of a CLI sign-in.
struct ProviderAPIKeySection: View {
    let session: ServerAdminSession
    let model: ProviderDetailModel
    let provider: ServerProviderEntry

    @State private var key = ""
    @State private var editing = false
    @State private var confirmingRemoval = false

    var body: some View {
        Section {
            if !provider.hasAuth || editing {
                SecureField(editing ? "New API key" : "\(provider.label) API key", text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(!allowed)
                Button("Save") {
                    Task {
                        if await model.saveKey(key) {
                            key = ""
                            editing = false
                        }
                    }
                }
                .disabled(!allowed || model.busy || key.trimmingCharacters(in: .whitespaces).isEmpty)
                if editing {
                    Button("Cancel", role: .cancel) {
                        key = ""
                        editing = false
                    }
                }
            } else if provider.hasManagedKey {
                LabeledContent("API key", value: "Saved")
                Button("Change") { editing = true }
                    .disabled(!allowed || model.busy)
                Button(provider.removesKeyOutright ? "Remove" : "Reset", role: .destructive) {
                    confirmingRemoval = true
                }
                .disabled(!allowed || model.busy)
                // One row carries this, so it attaches once rather than once per row of the section.
                .confirmationDialog(
                    provider.removesKeyOutright ? "Remove the saved \(provider.label) key?" : "Reset the \(provider.label) key?",
                    isPresented: $confirmingRemoval,
                    titleVisibility: .visible
                ) {
                    Button(provider.removesKeyOutright ? "Remove Key" : "Reset Key", role: .destructive) {
                        Task { await model.removeKey() }
                    }
                } message: {
                    Text(provider.removesKeyOutright
                         ? "\(session.serverLabel) stops using this key. Conversations that need \(provider.label) fail until it has another credential."
                         : "\(session.serverLabel) goes back to the credential under this override.")
                }
            } else if provider.isServedByCli {
                LabeledContent("API key", value: "None")
                Button("Add API Key") { editing = true }
                    .disabled(!allowed || model.busy)
            } else {
                LabeledContent("API key", value: "Set on the server")
            }
        } header: {
            Text("API Key")
        } footer: {
            footer
        }
    }

    private var allowed: Bool { session.allows(.providerStoreCredential) }

    @ViewBuilder private var footer: some View {
        if let reason = session.denialReason(.providerStoreCredential) {
            Text(reason)
        } else if provider.isServedByCli || editing && provider.cliKind != nil && provider.hasAuth && !provider.hasManagedKey {
            Text("The engine prefers a key for API routing. Removing it goes back to the CLI sign-in.")
        } else if !provider.hasAuth || editing {
            Text("The key is stored on \(session.serverLabel) and never shown again.")
        } else if !provider.hasManagedKey {
            Text(provider.statusDetail)
        }
    }
}
