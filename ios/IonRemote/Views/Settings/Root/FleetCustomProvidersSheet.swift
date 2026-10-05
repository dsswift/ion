import SwiftUI

/// What the Fleet screen opens to manage a server's custom providers.
struct FleetCustomProvidersTarget: Identifiable, Equatable {
    /// The paired device id of the server.
    let serverId: String

    var id: String { serverId }
}

/// The custom providers of one server, opened from the Fleet screen: each
/// provider that exists only because the server's config defines it. Each
/// opens its provider screen, where it can be removed.
struct FleetCustomProvidersSheet: View {
    let session: ServerAdminSession

    @Environment(\.dismiss) private var dismiss
    @State private var catalog: ProvidersAdminModel

    init(session: ServerAdminSession) {
        self.session = session
        _catalog = State(initialValue: ProvidersAdminModel(client: session.client, serverId: session.serverId))
    }

    var body: some View {
        NavigationStack {
            List {
                if catalog.catalog == nil {
                    if let error = catalog.error {
                        AdminErrorRow(message: error)
                    } else {
                        AdminLoadingRow(text: "Reading \(session.serverLabel)…")
                    }
                } else {
                    Section {
                        let providers = Self.customProviders(catalog.providers)
                        if providers.isEmpty {
                            Text("\(session.serverLabel) uses only built-in providers.")
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
                        Text("Providers \(session.serverLabel)'s configuration defines, such as a company gateway. Open one to remove it.")
                    }
                }
            }
            .navigationTitle("Custom Providers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await catalog.follow() }
        .onAppear {
            DiagnosticLog.log("fleet: custom providers opened", tag: "settings.fleet", fields: ["server_id": session.serverId])
            session.open()
        }
        .onDisappear { session.close() }
    }

    /// The providers the server's config defines.
    static func customProviders(_ providers: [ServerProviderEntry]) -> [ServerProviderEntry] {
        providers.filter(\.custom)
    }
}
