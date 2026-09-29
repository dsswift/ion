import SwiftUI

/// The ready-made automations. Picking one opens a new automation filled in
/// from it; nothing is saved until it is saved.
struct AutomationTemplatesSheet: View {
    let onPick: (AutomationDefinition) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(AutomationTemplates.all) { template in
                        Button {
                            onPick(template.definition())
                            dismiss()
                        } label: {
                            Text(template.label).foregroundStyle(.primary)
                        }
                    }
                } footer: {
                    Text("Opens a new automation filled in from the template. Nothing is saved until you save it.")
                }
            }
            .navigationTitle("Start from a Template")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}
