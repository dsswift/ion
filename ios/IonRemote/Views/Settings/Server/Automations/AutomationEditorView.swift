import SwiftUI

/// The automation editor as a native form: Name and When, If, Then, and the
/// plain-language preview or the reason the rule cannot save.
struct AutomationEditorView: View {
    let session: ServerAdminSession
    let model: AutomationsAdminModel
    /// True inside the new-automation sheet: Cancel closes the sheet.
    let inSheet: Bool

    @State private var editor: AutomationEditorModel
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    init(session: ServerAdminSession, model: AutomationsAdminModel, definition: AutomationDefinition, isNew: Bool, inSheet: Bool) {
        self.session = session
        self.model = model
        self.inSheet = inSheet
        _editor = State(initialValue: AutomationEditorModel(definition: definition, isNew: isNew))
    }

    var body: some View {
        Form {
            whenSection
            conditionsSection
            actionsSection
            Section {
                if let error = editor.validationError {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout)
                } else {
                    Text(editor.preview).font(.callout).foregroundStyle(.secondary)
                }
            } header: {
                Text("Preview")
            } footer: {
                if let reason = session.denialReason(.automationUpsert) { Text(reason) }
            }
            if let error = model.operationError {
                Section { AdminErrorRow(message: error) }
            }
        }
        .navigationTitle(editor.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            session.open()
            model.operationError = nil
        }
        .onDisappear { session.close() }
        .toolbar {
            if inSheet {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(saving || editor.validationError != nil || !session.allows(.automationUpsert))
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        if await model.save(editor.finalized()) {
            Haptic.light()
            dismiss()
        }
    }

    // MARK: Name and When

    private var whenSection: some View {
        Section {
            TextField("Untitled automation", text: $editor.draft.name)
            Picker("When", selection: Binding(get: { editor.draft.trigger.event }, set: { editor.setEvent($0) })) {
                if editor.trigger == nil { Text("Choose an event").tag(editor.draft.trigger.event) }
                ForEach(AutomationCatalog.triggers, id: \.event) { Text($0.label).tag($0.event) }
            }
            .pickerStyle(.navigationLink)
            Toggle("Enabled", isOn: $editor.draft.enabled)
        } header: {
            Text("Name and When")
        }
    }

    // MARK: If

    @ViewBuilder private var conditionsSection: some View {
        Section {
            if let trigger = editor.trigger {
                if let conditions = editor.conditions {
                    if conditions.isEmpty {
                        Text("No conditions. This rule runs on every \(trigger.label.lowercased()).").font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(Array(conditions.enumerated()), id: \.offset) { index, condition in
                        AutomationConditionRow(editor: editor, trigger: trigger, condition: condition, index: index)
                    }
                    .onDelete { editor.removeConditions(at: $0) }
                    Button {
                        editor.addCondition()
                    } label: {
                        Label("Add Condition", systemImage: "plus")
                    }
                    .disabled(trigger.fields.isEmpty)
                } else {
                    Label("This rule uses advanced condition groups. They are kept as they are and shown read-only; edit them in the rule's JSON file to change them.", systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                }
            } else {
                Text("Select an event first to add conditions.").font(.callout).foregroundStyle(.secondary)
            }
        } header: {
            Text("If (all of)")
        }
    }

    // MARK: Then

    @ViewBuilder private var actionsSection: some View {
        Section {
            let actions = editor.actions
            if actions.isEmpty {
                Text("No actions yet. Add at least one for this rule to do anything.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(Array(actions.enumerated()), id: \.offset) { index, action in
                AutomationActionRow(editor: editor, projects: model.projects, action: action, index: index, count: actions.count)
            }
            .onDelete { editor.removeActions(at: $0) }
            Button {
                editor.addAction()
            } label: {
                Label("Add Action", systemImage: "plus")
            }
            if editor.branchCount > 0 {
                Label("This rule also has \(editor.branchCount) conditional branch\(editor.branchCount == 1 ? "" : "es") kept read-only here; edit them in the rule's JSON file.", systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange)
            }
        } header: {
            Text("Then")
        }
    }
}
