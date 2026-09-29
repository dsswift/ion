import SwiftUI

/// The automations section of a server: which project's rules are listed,
/// whether AI actions are pre-authorized, every automation with its switch,
/// new and template automations, and the recent activity.
struct AutomationsAdminSection: View {
    let session: ServerAdminSession

    @State private var model: AutomationsAdminModel
    @State private var draft: AutomationDraftItem?
    @State private var showTemplates = false
    @State private var deleting: AutomationDefinition?

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: AutomationsAdminModel(session: session))
    }

    var body: some View {
        if model.locked {
            Label("Enterprise policy locks changes to automations on \(session.serverLabel).", systemImage: "lock.fill")
                .font(.callout)
                .foregroundStyle(.orange)
        }
        projectPicker
            .task { await model.load() }
            .reloadsWithServerPage("automation") { [model] in await model.load() }
            .sheet(item: $draft) { item in AutomationEditorSheet(session: session, model: model, item: item) }
            .sheet(isPresented: $showTemplates) {
                AutomationTemplatesSheet { definition in draft = AutomationDraftItem(definition: definition, isNew: true) }
            }
            .confirmationDialog(
                "Delete \(deleting?.name ?? "automation")?",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible,
                presenting: deleting
            ) { definition in
                Button("Delete", role: .destructive) {
                    Task { if await model.delete(id: definition.id) { Haptic.light() } }
                }
            } message: { _ in
                Text("Removes this automation from \(session.serverLabel).")
            }
        LabeledContent("AI Actions") {
            switch model.aiActionsAuthorized {
            case .some(true): Text("Authorized")
            case .some(false): Text("Need confirmation").foregroundStyle(.orange)
            case .none: Text("—")
            }
        }
        entries
        if !model.locked {
            Button {
                draft = AutomationDraftItem(definition: AutomationDraft.blank(), isNew: true)
            } label: {
                Label("New Automation", systemImage: "plus")
            }
            .disabled(!session.allows(.automationUpsert))
            Button {
                showTemplates = true
            } label: {
                Label("New from Template", systemImage: "sparkles")
            }
            .disabled(!session.allows(.automationUpsert))
            if let reason = session.denialReason(.automationUpsert) {
                Text(reason).font(.footnote).foregroundStyle(.secondary)
            }
        }
        NavigationLink {
            AutomationActivityView(session: session, model: model)
        } label: {
            LabeledContent("Recent Activity") {
                if let runs = model.recentRuns {
                    Text("\(runs.count)")
                } else {
                    Text(model.loadError == nil ? "Loading…" : "Unavailable")
                }
            }
        }
        if let error = model.operationError, draft == nil {
            AdminErrorRow(message: error)
        }
    }

    private var projectPicker: some View {
        Picker(selection: Binding(get: { model.projectPath }, set: { path in Task { await model.setProjectPath(path) } })) {
            Text("None").tag("")
            if !model.projectPath.isEmpty, !model.projects.contains(where: { $0.dir == model.projectPath }) {
                Text(model.projectPath).tag(model.projectPath)
            }
            ForEach(model.projects) { project in Text(project.displayName).tag(project.dir) }
        } label: {
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Text("Project")
                Text("Adds the rules in that project's .ion/automation folder.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var entries: some View {
        if let listing = model.listing {
            if listing.entries.isEmpty {
                Text("No automations yet. Create one, or start from a template.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(listing.entries) { entry in
                AutomationRow(entry: entry, canToggle: model.canToggle(entry) && session.allows(toggleAction(entry)) && !model.busy) {
                    Task { await model.toggle(entry) }
                } destination: {
                    if model.isEditable(entry) {
                        AutomationEditorView(session: session, model: model, definition: entry.definition, isNew: false, inSheet: false)
                    } else {
                        AutomationReadOnlyView(session: session, model: model, entry: entry)
                    }
                }
                .swipeActions(edge: .trailing) {
                    if model.isEditable(entry) && session.allows(.automationDelete) {
                        Button("Delete", role: .destructive) { deleting = entry.definition }
                    }
                    if !model.locked && session.allows(.automationDuplicate) {
                        Button("Duplicate") {
                            Task {
                                if let copy = await model.duplicate(id: entry.definition.id) {
                                    draft = AutomationDraftItem(definition: copy, isNew: false)
                                }
                            }
                        }
                        .tint(.blue)
                    }
                }
            }
        } else if let error = model.loadError {
            AdminErrorRow(message: error)
        } else {
            AdminLoadingRow(text: "Loading automations…")
        }
    }

    private func toggleAction(_ entry: AutomationSourceEntry) -> PhoneAction {
        entry.source == .project ? .automationSetProjectEnabled : .automationUpsert
    }
}
