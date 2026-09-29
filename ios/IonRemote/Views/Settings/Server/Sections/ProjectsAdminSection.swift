import SwiftUI

/// The Projects section of a server: a link to its full project list, Add
/// project, and where clones land.
struct ProjectsAdminSection: View {
    let session: ServerAdminSession

    @State private var model: ProjectsAdminModel
    @State private var showAdd = false
    @AppStorage private var baseDir: String

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: ProjectsAdminModel(session: session))
        _baseDir = AppStorage(wrappedValue: CloneBaseDirectory.defaultValue, CloneBaseDirectory.key(serverId: session.serverId))
    }

    var body: some View {
        NavigationLink {
            ProjectsListView(session: session, model: model)
        } label: {
            LabeledContent("Projects") { countLabel }
        }
        .task { await model.follow() }
        .reloadsWithServerPage("projects") { [model] in await model.load() }
        .sheet(isPresented: $showAdd) { AddProjectSheet(session: session, projects: model) }
        if let error = model.loadError, model.projects == nil {
            AdminErrorRow(message: error)
        }
        Button("Add Project") { showAdd = true }
            .disabled(!session.allows(.environmentProjectsAdd))
        if let reason = session.denialReason(.environmentProjectsAdd) {
            Text(reason).font(.footnote).foregroundStyle(.secondary)
        }
        NavigationLink {
            CloneBaseFolderView(session: session)
        } label: {
            LabeledContent("Base Folder for Clones") {
                Text(baseDir.isEmpty ? CloneBaseDirectory.defaultValue : baseDir).font(.callout.monospaced())
            }
        }
    }

    @ViewBuilder private var countLabel: some View {
        if let projects = model.projects {
            let working = model.rows.filter { if case .job = $0 { return true } else { return false } }.count
            Text(working > 0 ? "\(projects.count) · \(working) in progress" : "\(projects.count)")
        } else if model.loadError != nil {
            Text("Unavailable")
        } else {
            Text("Loading…")
        }
    }
}
