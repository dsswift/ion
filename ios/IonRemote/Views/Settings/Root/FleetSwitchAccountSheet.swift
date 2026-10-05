import SwiftUI

/// What the Fleet screen opens to switch an account: one server, and the
/// provider when the account that was picked names one.
struct FleetSwitchTarget: Identifiable, Equatable {
    /// The paired device id of the server.
    let serverId: String
    let providerId: String?

    var id: String { "\(serverId)|\(providerId ?? "")" }
}

/// The provider CLI accounts of one server, opened from the Fleet screen.
/// With a provider, that provider's sign-ins; without one, every provider on
/// the server that signs in through a CLI. The sign-in runs on the server,
/// through its own provider CLI.
struct FleetSwitchAccountSheet: View {
    let session: ServerAdminSession
    let providerId: String?

    @Environment(\.dismiss) private var dismiss
    @State private var catalog: ProvidersAdminModel

    init(session: ServerAdminSession, providerId: String?) {
        self.session = session
        self.providerId = providerId
        _catalog = State(initialValue: ProvidersAdminModel(client: session.client, serverId: session.serverId))
    }

    var body: some View {
        NavigationStack {
            content
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .task { await catalog.follow() }
        .onAppear {
            DiagnosticLog.log("fleet: switch account opened", tag: "settings.fleet", fields: [
                "server_id": session.serverId, "provider": providerId ?? "(any)"
            ])
            session.open()
        }
        .onDisappear { session.close() }
    }

    @ViewBuilder private var content: some View {
        if catalog.catalog == nil {
            List {
                if let error = catalog.error {
                    AdminErrorRow(message: error)
                } else {
                    AdminLoadingRow(text: "Reading \(session.serverLabel)…")
                }
            }
            .navigationTitle(session.serverLabel)
            .navigationBarTitleDisplayMode(.inline)
        } else if let providerId {
            ProviderDetailView(session: session, catalog: catalog, providerId: providerId)
        } else {
            List {
                Section {
                    let providers = Self.cliProviders(catalog.providers)
                    if providers.isEmpty {
                        Text("\(session.serverLabel) reports no provider that signs in through a CLI.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(providers) { provider in
                        NavigationLink {
                            ProviderDetailView(session: session, catalog: catalog, providerId: provider.id)
                        } label: {
                            ProviderRow(provider: provider)
                        }
                    }
                } footer: {
                    Text("Pick a provider to sign its CLI on \(session.serverLabel) in to another account.")
                }
            }
            .navigationTitle("Accounts on \(session.serverLabel)")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    /// The providers that sign in through a CLI.
    static func cliProviders(_ providers: [ServerProviderEntry]) -> [ServerProviderEntry] {
        providers.filter { $0.cliKind != nil }
    }
}
