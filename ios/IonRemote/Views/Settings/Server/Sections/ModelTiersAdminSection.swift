import SwiftUI

/// How a server routes models: its default provider, then its model tiers.
/// A row opens the tier; a custom tier swipes away; Add Tier adds one.
struct ModelTiersAdminSection: View {
    let session: ServerAdminSession

    @State private var model: ModelTiersModel
    @State private var adding = false
    @State private var removing: String?

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: ModelTiersModel(client: session.client, serverId: session.serverId))
    }

    var body: some View {
        Group {
            if model.tiers != nil, let provider = model.defaultProvider {
                defaultProviderRow(provider)
                ForEach(model.orderedTiers) { tier in
                    NavigationLink {
                        ModelTierEditView(session: session, model: model, name: tier.name)
                    } label: {
                        ModelTierRow(tier: tier)
                    }
                    .swipeActions {
                        if !tier.isBuiltIn, session.allows(.modelRemoveTier) {
                            Button("Remove", role: .destructive) { removing = tier.name }
                        }
                    }
                }
                Button {
                    adding = true
                } label: {
                    Label("Add Tier", systemImage: "plus")
                }
                .disabled(!session.allows(.modelSetTier))
                // One row carries this, so it attaches once rather than once per row of the section.
                .sheet(isPresented: $adding) { AddModelTierSheet(model: model) }
                .confirmationDialog(
                    "Remove the \(removing ?? "") tier?",
                    isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                    titleVisibility: .visible
                ) {
                    Button("Remove Tier", role: .destructive) {
                        guard let name = removing else { return }
                        Task { await model.remove(name) }
                    }
                } message: {
                    Text("Anything on \(session.serverLabel) that asks for this tier stops resolving it.")
                }
                if let reason = session.denialReason(.modelSetTier) {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                }
                if let error = model.error, !adding { AdminErrorRow(message: error) }
            } else if let error = model.error {
                AdminErrorRow(message: error)
            } else {
                AdminLoadingRow(text: "Loading model tiers…")
            }
        }
        .task { await model.follow() }
        .reloadsWithServerPage("model-tiers") { [model] in await model.load() }
    }

    private func defaultProviderRow(_ provider: String) -> some View {
        Picker(selection: Binding(get: { provider }, set: { next in Task { await model.setDefaultProvider(next) } })) {
            Text("No preference").tag("")
            ForEach(model.defaultProviderChoices, id: \.id) { choice in
                Text(choice.label).tag(choice.id)
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("Default provider")
                Text("Used when a model name does not name its provider.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .pickerStyle(.menu)
        .disabled(!session.allows(.providerSetDefault) || model.busy)
    }
}
