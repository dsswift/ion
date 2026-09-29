import SwiftUI

/// Adds or changes the relay a server reaches its phones through when they
/// are off its network. The server itself tests the relay, so what is saved
/// is what the server can reach.
struct RelayEditSheet: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let serverLabel: String
    let editing: Bool
    @State var model: RelayEditModel
    let onSaved: (RelaySettings, RelayAuthConfig?) -> Void
    let onRemove: () async -> Void

    @State private var confirmingRemove = false

    var body: some View {
        NavigationStack {
            Form {
                urlSection
                if model.discovering { discoveredSection }
                authSection
                if let error = model.error {
                    Section {
                        Text(error).foregroundStyle(theme.statusError)
                    }
                }
                if editing {
                    Section {
                        Button("Remove relay", role: .destructive) { confirmingRemove = true }
                            .disabled(model.saving)
                    } footer: {
                        Text("Without a relay, phones reach \(serverLabel) only on its own network.")
                    }
                }
            }
            .navigationTitle(editing ? "Edit relay" : "Add relay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.saving {
                        ProgressView()
                    } else {
                        Button(model.isEntra ? "Connect" : "Test & Save") { save() }
                            .disabled(!model.probeCurrent || model.trimmedURL.isEmpty)
                    }
                }
            }
            .confirmationDialog("Remove the relay?", isPresented: $confirmingRemove, titleVisibility: .visible) {
                Button("Remove relay", role: .destructive) {
                    Task {
                        await onRemove()
                        dismiss()
                    }
                }
            } message: {
                Text("Phones off \(serverLabel)'s network lose their way to it until a relay is set again.")
            }
        }
        .task(id: model.url) { await probeAfterTyping() }
        .task { await model.watch() }
        .onDisappear { Task { await model.stopDiscovery() } }
    }

    private var urlSection: some View {
        Section {
            TextField("ws://relay.example.com:8080", text: $model.url)
                .font(.body.monospaced())
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button(model.discovering ? "Stop looking" : "Find relays on the server's network", systemImage: "magnifyingglass") {
                Task {
                    if model.discovering { await model.stopDiscovery() } else { await model.startDiscovery() }
                }
            }
        } header: {
            Text("Relay URL")
        } footer: {
            Text("A relay carries \(serverLabel)'s traffic to a phone that is not on the same network.")
        }
    }

    private var discoveredSection: some View {
        Section("On the server's network") {
            if model.discovered.isEmpty {
                HStack(spacing: IonSpace.compactGap) {
                    ProgressView()
                    Text("Looking for relays…").foregroundStyle(theme.textSecondary)
                }
            }
            ForEach(model.discovered) { relay in
                Button {
                    Task { await model.pick(relay) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(relay.name).foregroundStyle(theme.textPrimary)
                        Text("\(relay.host):\(relay.port)")
                            .font(.caption.monospaced())
                            .foregroundStyle(theme.textSecondary)
                    }
                }
            }
        }
    }

    @ViewBuilder private var authSection: some View {
        if !model.trimmedURL.isEmpty {
            Section {
                if !model.probeCurrent {
                    HStack(spacing: IonSpace.compactGap) {
                        ProgressView()
                        Text("Checking how the relay signs in…").foregroundStyle(theme.textSecondary)
                    }
                } else if model.isEntra {
                    if let user = model.signedInUser {
                        Label("\(serverLabel) is signed in as \(user).", systemImage: "checkmark.seal")
                    } else {
                        Label("This relay admits Microsoft Entra accounts. Sign \(serverLabel) in under Integrations → Enterprise sign-in, then come back.", systemImage: "person.badge.key")
                    }
                } else {
                    SecureField("API key", text: $model.apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            } header: {
                Text("Sign-in")
            } footer: {
                if model.probeCurrent && !model.isEntra {
                    Text(model.auth == nil
                         ? "The relay did not say how it signs in. Enter its shared key if it uses one."
                         : "The shared key the relay admits. \(serverLabel) tests it before saving.")
                }
            }
        }
    }

    /// Probes the relay once typing pauses.
    private func probeAfterTyping() async {
        do {
            try await Task.sleep(for: .milliseconds(500))
        } catch {
            return // cancelled: the URL changed again, or the sheet closed
        }
        await model.probe()
    }

    private func save() {
        Task {
            guard let saved = await model.save() else { return }
            onSaved(saved, model.auth)
            dismiss()
        }
    }
}
