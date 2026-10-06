import SwiftUI

/// One project on a server: its checkout, whether Ion may run its code, its
/// setup, and the verbs that move or remove it.
struct ProjectDetailView: View {
    let session: ServerAdminSession
    let model: ProjectsAdminModel

    /// Follows the project when Change location moves it.
    @State private var dir: String
    @State private var removal: ProjectRemovalRequest?
    @Environment(\.dismiss) private var dismiss

    init(session: ServerAdminSession, model: ProjectsAdminModel, dir: String) {
        self.session = session
        self.model = model
        _dir = State(initialValue: dir)
    }

    var body: some View {
        Group {
            if let project = model.project(dir: dir) {
                content(project)
            } else if model.projects == nil {
                List { AdminLoadingRow(text: "Loading project…") }
            } else {
                ContentUnavailableView("Project removed", systemImage: "folder.badge.minus", description: Text("\(ProjectListRow.baseName(dir)) is no longer a project on \(session.serverLabel)."))
            }
        }
        .navigationTitle(model.project(dir: dir)?.displayName ?? ProjectListRow.baseName(dir))
        .navigationBarTitleDisplayMode(.inline)
        .modifier(ProjectRemovalDialog(request: $removal, model: model, onRemoved: { dismiss() }))
        .task { await model.follow() }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }

    private func content(_ project: EnvironmentProject) -> some View {
        let busy = model.isBusy(project.dir)
        return List {
            if let error = model.operationError, error.dir == project.dir {
                Section { AdminErrorRow(message: error.message) }
            }
            Section {
                LabeledContent("Branch", value: project.isGitRepo ? project.branch ?? "Detached" : "Not a git checkout")
                if let origin = project.originUrl {
                    LabeledContent("Origin") { Text(origin).font(.callout.monospaced()).textSelection(.enabled).multilineTextAlignment(.trailing) }
                } else {
                    LabeledContent("Origin", value: "None")
                }
                LabeledContent("Cloned by Ion", value: project.clonedByIon ? "Yes" : "No")
                LabeledContent("Folder") { Text(project.dir).font(.callout.monospaced()).textSelection(.enabled).multilineTextAlignment(.trailing) }
            } header: {
                Text("Checkout")
            } footer: {
                if !project.exists { Text("The folder is missing on \(session.serverLabel)'s disk.") }
            }
            trustSection(project, busy: busy)
            setupSection(project, busy: busy)
            Section {
                Button("Fetch from Origin") { Task { await model.fetchOrigin(project) } }
                    .disabled(busy || !project.isGitRepo || project.originUrl == nil || !session.allows(.environmentGitTest))
                if let test = model.originTests[project.dir] {
                    Label(test.ok ? "Reachable · \(test.defaultBranch ?? "HEAD") · \(Int(test.durationMs)) ms" : "Refused: \(test.error ?? "no answer")",
                          systemImage: test.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .font(.callout)
                        .foregroundStyle(test.ok ? .green : .red)
                }
                NavigationLink("Change Location") {
                    MoveProjectView(session: session, model: model, project: project) { moved in dir = moved.dir }
                }
                .disabled(busy || !project.exists || !session.allows(.environmentProjectsRelocate))
            } footer: {
                if let reason = session.denialReason(.environmentProjectsRelocate) { Text(reason) }
            }
            Section {
                Button("Remove…", role: .destructive) {
                    Task {
                        guard let appraisal = await model.appraiseRemoval(project) else { return }
                        removal = ProjectRemovalRequest(project: project, appraisal: appraisal)
                    }
                }
                .disabled(busy || !session.allows(.environmentProjectsRemove))
            }
        }
    }

    private func trustSection(_ project: EnvironmentProject, busy: Bool) -> some View {
        Section {
            if project.isTrusted {
                Text("Ion runs this project's code, including its setup.")
                    .foregroundStyle(.secondary)
            } else {
                Text(untrustedExplanation(project))
                    .foregroundStyle(.secondary)
                Button("Trust Project") { Task { await model.trust(project) } }
                    .disabled(busy || !project.exists || !session.allows(.environmentProjectsTrust))
            }
        } header: {
            Text("Trust")
        } footer: {
            if !project.isTrusted, let reason = session.denialReason(.environmentProjectsTrust) { Text(reason) }
        }
    }

    private func setupSection(_ project: EnvironmentProject, busy: Bool) -> some View {
        let blocked = Self.setupBlockedReason(project)
        return Section {
            Text(setupDescription(project))
                .foregroundStyle(project.setup?.state == .failed ? .red : .secondary)
            Button("Run Setup") { Task { await model.runSetup(project) } }
                .disabled(busy || blocked != nil || !session.allows(.environmentProjectsSetup))
        } header: {
            Text("Setup")
        } footer: {
            if let reason = blocked ?? session.denialReason(.environmentProjectsSetup) { Text(reason) }
        }
    }

    private func untrustedExplanation(_ project: EnvironmentProject) -> String {
        let setup = project.setupCommand.map { ", including its setup: \($0)" } ?? ""
        return "Ion cloned this project and runs none of its code until you trust it\(setup)."
    }

    private func setupDescription(_ project: EnvironmentProject) -> String {
        if let job = model.runningJob(dir: project.dir) {
            let percent = job.percent.map { " \(Int($0))%" } ?? ""
            let detail = job.detail.map { ". \($0)" } ?? ""
            return "\(job.kind.title): \(job.stage)\(percent)\(detail)"
        }
        switch project.setup?.state {
        case .running: return "Setup is running."
        case .ready: return "The last setup succeeded."
        case .failed: return "The last setup failed\(project.setup?.detail.map { ": \($0)" } ?? ".")"
        case .none?, nil: return project.setupCommand.map { "Runs \($0)." } ?? "The project declares no setup command."
        }
    }

    /// Why Run setup is unavailable, or nil when it can run.
    static func setupBlockedReason(_ project: EnvironmentProject) -> String? {
        if !project.exists { return "The folder is missing on disk." }
        if !project.isTrusted { return "Trust the project before running its setup." }
        return nil
    }
}
