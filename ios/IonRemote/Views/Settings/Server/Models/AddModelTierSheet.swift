import SwiftUI

/// Adds a custom tier: a name, a primary model, and an optional fallback.
struct AddModelTierSheet: View {
    let model: ModelTiersModel

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var primary = ""
    @State private var fallback = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, e.g. review", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text(model.nameProblem(name) ?? "Lowercase. Built-in tier names are reserved.")
                }
                Section {
                    let groups = model.choices(configured: [primary, fallback])
                    ModelChoicePicker(title: "Primary", emptyLabel: "Select a model", groups: groups, selection: $primary)
                    ModelChoicePicker(title: "Fallback", emptyLabel: "None", groups: groups, selection: $fallback)
                } footer: {
                    Text("A custom tier routes to its primary model, then its fallback.")
                }
                if let error = model.error {
                    Section { AdminErrorRow(message: error) }
                }
            }
            .navigationTitle("Add Tier")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { add() }
                        .disabled(!canAdd)
                }
            }
        }
    }

    private var normalizedName: String { name.trimmingCharacters(in: .whitespaces).lowercased() }

    private var canAdd: Bool {
        !saving && !normalizedName.isEmpty && !primary.isEmpty && model.nameProblem(name) == nil
    }

    private func add() {
        saving = true
        Task {
            let saved = await model.save(ModelTier(name: normalizedName, model: primary, fallbacks: fallback.isEmpty ? [] : [fallback]))
            saving = false
            if saved { dismiss() }
        }
    }
}
