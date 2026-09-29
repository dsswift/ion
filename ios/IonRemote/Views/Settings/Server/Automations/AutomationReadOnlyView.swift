import SwiftUI

/// An automation this phone cannot edit in place: a project, enterprise, or
/// built-in rule, or any rule while enterprise policy locks changes.
/// Duplicate makes an editable copy of the person's own.
struct AutomationReadOnlyView: View {
    let session: ServerAdminSession
    let model: AutomationsAdminModel
    let entry: AutomationSourceEntry

    @State private var copy: AutomationDraftItem?

    var body: some View {
        List {
            Section {
                LabeledContent("Source") { AutomationSourceChips(entry: entry) }
                LabeledContent("When", value: AutomationDescribe.triggerLabel(entry.definition.trigger.event))
                LabeledContent("Then", value: AutomationDescribe.actionSummary(AutomationDraft.steps(entry.definition)))
            } footer: {
                Text("\(AutomationDescribe.sourceLabel(entry.source)) automation. Read-only here; duplicate it to make your own copy.")
            }
            Section {
                Text(AutomationDescribe.preview(entry.definition)).font(.callout).foregroundStyle(.secondary)
            }
            if !model.locked {
                Section {
                    Button {
                        Task {
                            if let duplicated = await model.duplicate(id: entry.definition.id) {
                                copy = AutomationDraftItem(definition: duplicated, isNew: false)
                            }
                        }
                    } label: {
                        Label("Duplicate", systemImage: "plus.square.on.square")
                    }
                    .disabled(model.busy || !session.allows(.automationDuplicate))
                } footer: {
                    if let reason = session.denialReason(.automationDuplicate) { Text(reason) }
                }
            }
            if let error = model.operationError {
                Section { AdminErrorRow(message: error) }
            }
        }
        .navigationTitle(entry.definition.name)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { session.open() }
        .onDisappear { session.close() }
        .sheet(item: $copy) { item in
            AutomationEditorSheet(session: session, model: model, item: item)
        }
    }
}
