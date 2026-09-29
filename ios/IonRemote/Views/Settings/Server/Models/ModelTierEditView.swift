import SwiftUI

/// One tier's primary model and its first fallback. Each pick saves at once.
struct ModelTierEditView: View {
    let session: ServerAdminSession
    let model: ModelTiersModel
    let name: String

    @Environment(\.dismiss) private var dismiss
    @State private var confirmingRemoval = false

    var body: some View {
        List {
            if let tier = model.tier(named: name) {
                let groups = model.choices(configured: [tier.model, tier.fallbacks.first ?? ""])
                Section {
                    ModelChoicePicker(
                        title: "Primary",
                        emptyLabel: emptyPrimaryLabel(tier),
                        groups: groups,
                        selection: Binding(get: { tier.model }, set: { next in Task { await model.setPrimary(tier, model: next) } })
                    )
                    ModelChoicePicker(
                        title: "Fallback",
                        emptyLabel: "None",
                        groups: groups,
                        selection: Binding(get: { tier.fallbacks.first ?? "" }, set: { next in Task { await model.setFallback(tier, model: next) } })
                    )
                } footer: {
                    VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                        if tier.isBuiltIn {
                            Text("A built-in tier. It stays available and needs an explicit primary model.")
                        }
                        if tier.fallbacks.count > 1 {
                            Text("\(tier.fallbacks.count - 1) more fallbacks set elsewhere stay active on the server.")
                        }
                        if let reason = session.denialReason(.modelSetTier) { Text(reason) }
                    }
                }
                .disabled(!session.allows(.modelSetTier) || model.busy)
                if let error = model.error {
                    Section { AdminErrorRow(message: error) }
                }
                if !tier.isBuiltIn {
                    Section {
                        Button("Remove Tier", role: .destructive) { confirmingRemoval = true }
                            .disabled(!session.allows(.modelRemoveTier) || model.busy)
                    }
                }
            } else {
                Section { Text("\(session.serverLabel) no longer has this tier.").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Remove the \(name) tier?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
            Button("Remove Tier", role: .destructive) {
                Task {
                    await model.remove(name)
                    if model.error == nil { dismiss() }
                }
            }
        } message: {
            Text("Anything on \(session.serverLabel) that asks for this tier stops resolving it.")
        }
    }

    private func emptyPrimaryLabel(_ tier: ModelTier) -> String {
        if tier.name == ModelTier.workbenchSync { return "Default (uses standard tier)" }
        return tier.isBuiltIn ? "Not configured" : "Select a model"
    }
}
