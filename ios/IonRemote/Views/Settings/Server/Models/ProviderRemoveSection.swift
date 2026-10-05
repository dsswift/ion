import SwiftUI

/// Removes a custom provider from the server: its config entry, its saved
/// key, and its models. Asks once first, then leaves the provider's screen.
struct ProviderRemoveSection: View {
    let session: ServerAdminSession
    let model: ProviderDetailModel
    let provider: ServerProviderEntry

    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        Section {
            Button("Remove Provider", role: .destructive) {
                confirming = true
            }
            .disabled(!session.allows(.providerRemove) || model.busy)
            .confirmationDialog(
                "Remove \(provider.label) from \(session.serverLabel)?",
                isPresented: $confirming,
                titleVisibility: .visible
            ) {
                Button("Remove Provider", role: .destructive) {
                    Task {
                        if await model.removeProvider() { dismiss() }
                    }
                }
            } message: {
                Text("Its gateway, its saved key, and its models go too. Adding it back means setting it up again.")
            }
        } footer: {
            if let reason = session.denialReason(.providerRemove) {
                Text(reason)
            } else {
                Text("\(provider.label) exists only because \(session.serverLabel)'s configuration defines it.")
            }
        }
    }
}
