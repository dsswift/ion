import SwiftUI

/// One action of the Then step: which action, what it targets (always from
/// the event, or a directory on the server), and its settings.
struct AutomationActionRow: View {
    @Environment(\.appTheme) private var theme
    let editor: AutomationEditorModel
    let projects: [EnvironmentProject]
    let action: AutomationAction
    let index: Int
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.compactGap) {
            Picker("Action", selection: Binding(get: { action.kind }, set: { editor.setActionKind($0, at: index) })) {
                if AutomationCatalog.action(action.kind) == nil { Text(action.kind).tag(action.kind) }
                ForEach(AutomationCatalog.actions, id: \.kind) { Text($0.label).tag($0.kind) }
            }
            if let spec = AutomationCatalog.action(action.kind) {
                target(spec)
                ForEach(spec.config, id: \.key) { field in
                    config(field)
                }
            }
        }
        .padding(.vertical, IonSpace.hairlineGap)
        .contextMenu {
            Button { editor.moveActions(from: [index], to: index - 1) } label: { Label("Move Up", systemImage: "arrow.up") }
                .disabled(index == 0)
            Button { editor.moveActions(from: [index], to: index + 2) } label: { Label("Move Down", systemImage: "arrow.down") }
                .disabled(index == count - 1)
        }
    }

    @ViewBuilder
    private func target(_ spec: AutomationActionSpec) -> some View {
        let trigger = editor.trigger
        let satisfied = trigger.map { AutomationDraft.targetSatisfied(spec, $0, action) } ?? false
        switch spec.target {
        case .none:
            EmptyView()
        case .worktree:
            targetLine(satisfied ? "Target: the triggering worktree" : "This event cannot supply a worktree for this action", ok: satisfied)
        case .conversation:
            targetLine(satisfied ? "Target: the triggering conversation" : "This event cannot supply a conversation for this action", ok: satisfied)
        case .directory:
            if trigger?.provides.worktree == true {
                targetLine("Target: the triggering worktree", ok: true)
            } else {
                directoryField
            }
        }
    }

    private func targetLine(_ text: String, ok: Bool) -> some View {
        Label(text, systemImage: ok ? "scope" : "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(ok ? theme.textSecondary : theme.statusWarning)
    }

    private var directoryField: some View {
        let directory = action.payload?["directory"]?.stringValue ?? ""
        return VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            HStack {
                TextField("Target directory on the server", text: Binding(
                    get: { directory },
                    set: { editor.setConfig("directory", to: .string($0), at: index) }
                ))
                .font(.callout.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                if !projects.isEmpty {
                    Menu {
                        ForEach(projects) { project in
                            Button(project.displayName) { editor.setConfig("directory", to: .string(project.dir), at: index) }
                        }
                    } label: {
                        Image(systemName: "folder")
                    }
                    .accessibilityLabel("Choose a project")
                }
            }
            if directory.isEmpty {
                targetLine("Choose a target directory", ok: false)
            }
        }
    }

    @ViewBuilder
    private func config(_ field: AutomationActionConfigField) -> some View {
        let value = action.payload?[field.key]
        if action.kind == "tab:set-color" && field.key == "color" {
            Picker(field.label, selection: Binding(
                get: { value?.stringValue ?? "" },
                set: { editor.setConfig(field.key, to: $0.isEmpty ? nil : .string($0), at: index) }
            )) {
                ForEach(AutomationCatalog.tabColorPresets, id: \.label) { preset in
                    Text(preset.label).tag(preset.color ?? "")
                }
            }
        } else {
            AutomationValueControl(
                label: field.label,
                type: field.type,
                choices: field.values,
                allowsNone: !field.required,
                value: value,
                onChange: { editor.setConfig(field.key, to: $0, at: index) }
            )
        }
    }
}
