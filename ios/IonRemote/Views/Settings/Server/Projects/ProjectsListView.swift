import SwiftUI

/// Every project on one server, searchable: jobs without a project yet on
/// top (with Cancel or Retry), then one row per project leading to its detail.
struct ProjectsListView: View {
    let session: ServerAdminSession
    let model: ProjectsAdminModel

    @State private var query = ""
    @State private var showAdd = false
    @State private var removal: ProjectRemovalRequest?

    var body: some View {
        let rows = model.rows.filter { $0.matches(query) }
        List {
            if let error = model.operationError {
                Section { AdminErrorRow(message: "\(model.project(dir: error.dir)?.displayName ?? ProjectListRow.baseName(error.dir)): \(error.message)") }
            }
            if model.projects == nil {
                Section {
                    if let error = model.loadError {
                        AdminErrorRow(message: error)
                        Button("Try Again") { Task { await model.load() } }
                    } else {
                        AdminLoadingRow(text: "Loading projects…")
                    }
                }
            } else {
                let jobRows = rows.filter { if case .job = $0 { return true } else { return false } }
                let projectRows = rows.filter { if case .project = $0 { return true } else { return false } }
                if !jobRows.isEmpty {
                    Section("In Progress") {
                        ForEach(jobRows) { row in jobRow(row) }
                    }
                }
                Section {
                    ForEach(projectRows) { row in projectRow(row) }
                } footer: {
                    if projectRows.isEmpty {
                        Text(query.isEmpty ? "No projects on \(session.serverLabel) yet. Add one to start a conversation there." : "No project matches \u{201C}\(query)\u{201D}.")
                    } else {
                        Text("Repositories on \(session.serverLabel) that conversations can start in.")
                    }
                }
            }
        }
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Name, path, or branch")
        .refreshable { await model.load() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAdd = true } label: { Label("Add Project", systemImage: "plus") }
                    .disabled(!session.allows(.environmentProjectsAdd))
            }
        }
        .sheet(isPresented: $showAdd) { AddProjectSheet(session: session, projects: model) }
        .modifier(ProjectRemovalDialog(request: $removal, model: model))
        .task { await model.follow() }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }

    @ViewBuilder private func jobRow(_ row: ProjectListRow) -> some View {
        if case .job(let job) = row {
            ProjectRowView(row: row)
                .swipeActions {
                    if job.phase == .running {
                        Button("Cancel", role: .destructive) { Task { await model.cancel(job) } }
                            .disabled(!session.allows(.environmentJobsCancel))
                    } else if job.url != nil {
                        Button("Retry") {
                            Task { await model.retry(job, parentDir: CloneBaseDirectory.read(serverId: session.serverId)) }
                        }
                        .tint(.accentColor)
                        .disabled(!session.allows(.environmentProjectsClone))
                    }
                }
                .contextMenu {
                    if job.phase == .running {
                        Button(role: .destructive) { Task { await model.cancel(job) } } label: { Label("Cancel", systemImage: "xmark") }
                    } else if job.url != nil {
                        Button {
                            Task { await model.retry(job, parentDir: CloneBaseDirectory.read(serverId: session.serverId)) }
                        } label: { Label("Retry", systemImage: "arrow.clockwise") }
                    }
                }
        }
    }

    @ViewBuilder private func projectRow(_ row: ProjectListRow) -> some View {
        if case .project(let project, _) = row {
            NavigationLink {
                ProjectDetailView(session: session, model: model, dir: project.dir)
            } label: {
                ProjectRowView(row: row)
            }
            .swipeActions {
                if session.allows(.environmentProjectsRemove) {
                    Button("Remove", role: .destructive) { Task { await askRemoval(project) } }
                        .disabled(model.isBusy(project.dir))
                }
            }
            .contextMenu {
                if !project.isTrusted {
                    Button { Task { await model.trust(project) } } label: { Label("Trust Project", systemImage: "checkmark.shield") }
                        .disabled(!session.allows(.environmentProjectsTrust) || !project.exists)
                }
                Button { Task { await model.runSetup(project) } } label: { Label("Run Setup", systemImage: "wrench.and.screwdriver") }
                    .disabled(!session.allows(.environmentProjectsSetup) || ProjectDetailView.setupBlockedReason(project) != nil)
                Button(role: .destructive) { Task { await askRemoval(project) } } label: { Label("Remove…", systemImage: "trash") }
                    .disabled(!session.allows(.environmentProjectsRemove))
            }
        }
    }

    private func askRemoval(_ project: EnvironmentProject) async {
        guard let appraisal = await model.appraiseRemoval(project) else { return }
        removal = ProjectRemovalRequest(project: project, appraisal: appraisal)
    }
}
