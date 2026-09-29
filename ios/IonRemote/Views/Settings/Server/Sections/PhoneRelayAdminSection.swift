import SwiftUI

/// Phone and relay: the name and icon the server shows on every paired phone,
/// and the relay that reaches a phone off the server's network. The
/// low-bandwidth switches are projected settings and render below these rows.
struct PhoneRelayAdminSection: View {
    @Environment(\.appTheme) private var theme
    let session: ServerAdminSession
    @State private var model: PhoneRelayAdminModel
    @State private var sheet: PhoneRelaySheet?
    @State private var confirmingRemove = false

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: PhoneRelayAdminModel(
            client: session.client, serverId: session.serverId,
            canProbeRelay: { [weak session] in session?.allows(.remoteRelayAuthConfig) ?? false }
        ))
    }

    private var displayDenial: String? { session.denialReason(.remoteSetDisplay) }
    /// The relay is a server-wide setting tested from the server: admin's.
    private var relayDenial: String? { session.denialReason(.remoteTestRelay) }

    var body: some View {
        displayRow
            .task { await model.load() }
            .reloadsWithServerPage("remote") { [model] in await model.load() }
            .sheet(item: $sheet) { which in
                switch which {
                case .display:
                    RemoteDisplayEditSheet(model: model)
                case .relay:
                    RelayEditSheet(
                        serverLabel: session.serverLabel,
                        editing: model.relay?.isConfigured ?? false,
                        model: RelayEditModel(client: session.client, serverId: session.serverId, current: model.relay ?? RelaySettings(relayUrl: "", relayApiKey: "")),
                        onSaved: { saved, auth in model.relaySaved(saved, auth: auth) },
                        onRemove: { await model.removeRelay() }
                    )
                }
            }
        if let displayDenial {
            caption(displayDenial)
        }
        relayRow
            .confirmationDialog("Remove the relay?", isPresented: $confirmingRemove, titleVisibility: .visible) {
                Button("Remove relay", role: .destructive) { Task { await model.removeRelay() } }
            } message: {
                Text("Phones off \(session.serverLabel)'s network lose their way to it until a relay is set again.")
            }
        if let relayDenial {
            caption(relayDenial)
        } else if let error = model.relayError {
            Text(error).font(.footnote).foregroundStyle(theme.statusError)
        }
    }

    // MARK: - Name on phones

    @ViewBuilder private var displayRow: some View {
        if model.displayLoaded {
            Button {
                open(.display)
            } label: {
                HStack(spacing: IonSpace.compactGap) {
                    Image(systemName: PairedDevice.iconSymbol(for: model.display?.customIcon ?? ""))
                        .foregroundStyle(theme.accent)
                        .frame(width: 24)
                    LabeledContent("Name on phones") {
                        Text(model.display?.customName ?? "Host name")
                            .foregroundStyle(model.display?.customName == nil ? theme.textSecondary : theme.textPrimary)
                    }
                    .foregroundStyle(theme.textPrimary)
                }
            }
            .disabled(displayDenial != nil)
        } else if let error = model.displayError {
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Text("The name on phones could not be read.")
                Text(error).font(.footnote).foregroundStyle(theme.statusError)
            }
        } else {
            HStack(spacing: IonSpace.compactGap) {
                ProgressView()
                Text("Loading…").foregroundStyle(theme.textSecondary)
            }
        }
    }

    // MARK: - Relay

    @ViewBuilder private var relayRow: some View {
        if let relay = model.relay {
            Button {
                open(.relay)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    LabeledContent("Relay") {
                        Text(relay.isConfigured ? relayMode : "LAN only")
                            .foregroundStyle(theme.textSecondary)
                    }
                    .foregroundStyle(theme.textPrimary)
                    if relay.isConfigured {
                        Text(relay.relayUrl)
                            .font(.caption.monospaced())
                            .foregroundStyle(theme.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            .disabled(relayDenial != nil || model.removingRelay)
            .swipeActions {
                if relay.isConfigured && relayDenial == nil {
                    Button("Remove", role: .destructive) { confirmingRemove = true }
                }
            }
        } else if model.relayError != nil {
            Text("The relay could not be read.")
        } else {
            HStack(spacing: IonSpace.compactGap) {
                ProgressView()
                Text("Loading relay…").foregroundStyle(theme.textSecondary)
            }
        }
    }

    private var relayMode: String {
        model.relayAuth?.modeName ?? "Set"
    }

    private func open(_ which: PhoneRelaySheet) {
        DiagnosticLog.log("phone and relay: sheet opened", tag: "admin.access", fields: ["server_id": session.serverId, "sheet": which.rawValue])
        sheet = which
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(theme.textSecondary)
    }
}
