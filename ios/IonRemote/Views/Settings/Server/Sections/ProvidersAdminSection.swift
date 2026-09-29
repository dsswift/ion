import SwiftUI

/// The Providers section of a server: one row per model provider with how
/// it is signed in, signed-in ones first. Each row opens the provider's
/// keys and sign-ins.
struct ProvidersAdminSection: View {
    let session: ServerAdminSession

    @State private var model: ProvidersAdminModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: ProvidersAdminModel(client: session.client, serverId: session.serverId))
    }

    var body: some View {
        Group {
            if let catalog = model.catalog {
                if model.providers.isEmpty {
                    Text(catalog.providers.isEmpty
                         ? "\(session.serverLabel) reports no providers. Its engine may be starting."
                         : "The organization's policy on \(session.serverLabel) permits none of its providers.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                ForEach(model.providers) { provider in
                    NavigationLink {
                        ProviderDetailView(session: session, catalog: model, providerId: provider.id)
                    } label: {
                        ProviderRow(provider: provider)
                    }
                }
            } else if let error = model.error {
                AdminErrorRow(message: error)
            } else {
                AdminLoadingRow(text: "Loading providers…")
            }
        }
        .task { await model.follow() }
        .reloadsWithServerPage("providers") { [model] in await model.load() }
    }
}
