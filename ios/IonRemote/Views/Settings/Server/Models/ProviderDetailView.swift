import SwiftUI

/// One provider on one server: its status, its sign-ins, its API key, a
/// model refresh, and, for a custom provider, its removal.
struct ProviderDetailView: View {
    let session: ServerAdminSession
    let catalog: ProvidersAdminModel

    @State private var model: ProviderDetailModel

    init(session: ServerAdminSession, catalog: ProvidersAdminModel, providerId: String) {
        self.session = session
        self.catalog = catalog
        _model = State(initialValue: ProviderDetailModel(providerId: providerId, catalog: catalog))
    }

    var body: some View {
        List {
            if let provider = model.provider {
                statusSection(provider)
                if let error = model.error {
                    Section { AdminErrorRow(message: error) }
                } else if let notice = model.notice {
                    Section { Label(notice, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                }
                if provider.takesBrowserSignIn {
                    ProviderBrowserSignInSection(session: session, model: model, provider: provider)
                }
                if provider.cliKind != nil {
                    ProviderCliSignInSection(session: session, model: model, provider: provider)
                }
                if provider.takesAPIKey {
                    ProviderAPIKeySection(session: session, model: model, provider: provider)
                }
                if provider.custom {
                    ProviderRemoveSection(session: session, model: model, provider: provider)
                }
            } else {
                Section {
                    Text("\(session.serverLabel) no longer lists this provider.").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(model.provider?.label ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.follow() }
        .onAppear { session.open() }
        .onDisappear {
            model.stop()
            session.close()
        }
    }

    private func statusSection(_ provider: ServerProviderEntry) -> some View {
        Section {
            LabeledContent("Sign-in", value: provider.statusLabel)
            if provider.hasCustomGateway, let baseURL = provider.baseURL {
                LabeledContent("Gateway") {
                    Text(baseURL).font(.callout.monospaced()).textSelection(.enabled)
                }
            }
            if let ref = provider.apiKeyRef, ref != "configured" {
                LabeledContent("Key reference") {
                    Text(ref).font(.callout.monospaced())
                }
            }
            if provider.hasAuth {
                let count = catalog.modelCount(for: provider.id)
                LabeledContent("Models", value: "\(count)")
                Button {
                    Task { await model.refreshModels() }
                } label: {
                    Label(model.refreshing ? "Refreshing Models…" : "Refresh Models", systemImage: "arrow.clockwise")
                }
                .disabled(model.refreshing || !session.allows(.modelRefresh))
            }
        } header: {
            Text("Status")
        } footer: {
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Text(provider.statusDetail)
                if provider.hasCustomGateway {
                    Text("Requests go to this endpoint instead of the public API.")
                }
                if provider.hasAuth, let reason = session.denialReason(.modelRefresh) {
                    Text(reason)
                }
                if showsStaleOpenAIKeyHint(provider) {
                    Text("This saved OpenAI key returns no models. Remove it below and sign in with ChatGPT instead.")
                }
            }
        }
    }

    /// A ChatGPT token saved as an OpenAI key returns no models and, since a
    /// key wins routing, blocks the CLI.
    private func showsStaleOpenAIKeyHint(_ provider: ServerProviderEntry) -> Bool {
        provider.id == "openai" && provider.hasAuth && provider.authSource == "filestore"
            && provider.backend != "codex" && catalog.modelCount(for: provider.id) == 0
    }
}
