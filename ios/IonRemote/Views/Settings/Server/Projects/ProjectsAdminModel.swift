import Foundation
import Observation

/// The projects and jobs of one server, as its Projects screens show them,
/// and the verbs those screens run on a project.
///
/// Every screen that shows this data runs `follow()` while it is on screen:
/// it reloads, then applies `ion:projects-changed` and `ion:project-job` as
/// they arrive.
@MainActor
@Observable
final class ProjectsAdminModel {

    /// A failed verb, and which project it was about.
    struct OperationError: Equatable {
        let dir: String
        let message: String
    }

    let serverId: String
    let serverLabel: String
    /// Nil until the first listing lands.
    private(set) var projects: [EnvironmentProject]?
    private(set) var jobs: [EnvironmentJob] = []
    private(set) var loading = false
    /// Why the last listing failed, in plain words.
    private(set) var loadError: String?
    private(set) var busyDirs: Set<String> = []
    var operationError: OperationError?
    /// The last origin test per project, from Fetch from origin.
    private(set) var originTests: [String: EnvironmentGitTest] = [:]

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let events: ServerAdminEvents

    init(serverId: String, serverLabel: String, client: ServerAdminClient, events: ServerAdminEvents = .shared) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
        self.events = events
    }

    convenience init(session: ServerAdminSession) {
        self.init(serverId: session.serverId, serverLabel: session.serverLabel, client: session.client)
    }

    var rows: [ProjectListRow] { ProjectListRow.build(projects: projects ?? [], jobs: jobs) }

    func project(dir: String) -> EnvironmentProject? { projects?.first { $0.dir == dir } }

    func runningJob(dir: String) -> EnvironmentJob? { jobs.first { $0.phase == .running && $0.dir == dir } }

    func isBusy(_ dir: String) -> Bool { busyDirs.contains(dir) }

    // MARK: - Loading

    /// Reloads, then keeps the lists current until the caller's task ends.
    func follow() async {
        let stream = events.events(for: serverId)
        await load()
        for await event in stream {
            await apply(event)
        }
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            async let listed = client.listProjects()
            async let running = client.listJobs()
            let (nextProjects, nextJobs) = try await (listed, running)
            projects = nextProjects
            jobs = nextJobs
            loadError = nil
            DiagnosticLog.log("projects: listed", tag: "admin.projects", level: .debug, fields: [
                "server_id": serverId, "projects": String(nextProjects.count), "jobs": String(nextJobs.count)
            ])
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
            DiagnosticLog.log("projects: listing failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    func apply(_ event: ServerAdminEvent) async {
        switch event.channel {
        case ServerAdminEvent.projectsChanged:
            await reloadProjects()
        case ServerAdminEvent.projectJob:
            do {
                let job = try event.payload.decoded(as: EnvironmentJob.self)
                upsert(job)
                // A finished clone registers its project; a finished setup changes its row.
                if job.phase != .running { await reloadProjects() }
            } catch {
                DiagnosticLog.log("projects: job event did not decode", tag: "admin.projects", level: .warn, fields: [
                    "server_id": serverId, "error": String(String(describing: error).prefix(300))
                ])
            }
        default:
            return
        }
    }

    private func upsert(_ job: EnvironmentJob) {
        if let index = jobs.firstIndex(where: { $0.id == job.id }) {
            jobs[index] = job
        } else {
            jobs.append(job)
        }
    }

    private func reloadProjects() async {
        do {
            projects = try await client.listProjects()
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
            DiagnosticLog.log("projects: relisting failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    // MARK: - Verbs

    func trust(_ project: EnvironmentProject) async {
        await run("trusted", dir: project.dir) { client in
            _ = try await client.trustProject(dir: project.dir)
        }
    }

    func runSetup(_ project: EnvironmentProject) async {
        await run("setup started", dir: project.dir) { client in
            try await client.setupProject(dir: project.dir)
        }
    }

    /// Tests that the project's origin answers with the server's credentials.
    func fetchOrigin(_ project: EnvironmentProject) async {
        guard let origin = project.originUrl else { return }
        await run("origin tested", dir: project.dir) { client in
            let test = try await client.testGitAccess(url: origin)
            originTests[project.dir] = test
            if !test.ok { throw StudioActionFailure.failed(code: "origin_unreachable", message: test.error ?? "The origin did not answer.") }
        }
    }

    /// Moves the project into `parent`, keeping its folder name. Returns the
    /// project at its new place, or nil when the move failed.
    func relocate(_ project: EnvironmentProject, intoParent parent: String) async -> EnvironmentProject? {
        let destination = "\(CloneBaseDirectory.normalized(parent))/\(ProjectListRow.baseName(project.dir))"
        var moved: EnvironmentProject?
        await run("relocated", dir: project.dir) { client in
            moved = try await client.relocateProject(from: project.dir, to: destination)
        }
        return moved
    }

    /// What removing `project` would touch, or nil when the server could not say.
    func appraiseRemoval(_ project: EnvironmentProject) async -> ProjectRemovalAppraisal? {
        do {
            return try await client.appraiseRemoval(dir: project.dir)
        } catch {
            fail(project.dir, operation: "appraise removal", error)
            return nil
        }
    }

    /// Removes `project`; with `deleteFiles` also deletes a checkout Ion
    /// cloned, forced when the appraisal found work that would be lost.
    @discardableResult
    func remove(_ project: EnvironmentProject, appraisal: ProjectRemovalAppraisal, deleteFiles: Bool) async -> Bool {
        await run(deleteFiles ? "removed with files" : "removed", dir: project.dir) { client in
            try await client.removeProject(dir: project.dir, deleteFiles: deleteFiles, force: deleteFiles && appraisal.isRisky)
        }
    }

    func cancel(_ job: EnvironmentJob) async {
        await run("job cancelled", dir: job.dir) { client in
            try await client.cancelJob(id: job.id)
        }
    }

    /// Clones a failed clone's URL again into the base folder.
    func retry(_ job: EnvironmentJob, parentDir: String) async {
        guard let url = job.url else { return }
        await run("clone retried", dir: job.dir) { client in
            _ = try await client.cloneProject(url: url, parentDir: parentDir)
        }
    }

    /// Runs one verb with a busy flag for its project, a log line either
    /// way, and a relisting when it lands.
    @discardableResult
    private func run(_ label: String, dir: String, _ body: (ServerAdminClient) async throws -> Void) async -> Bool {
        busyDirs.insert(dir)
        operationError = nil
        defer { busyDirs.remove(dir) }
        do {
            try await body(client)
            DiagnosticLog.log("projects: operation done", tag: "admin.projects", fields: [
                "server_id": serverId, "operation": label, "dir": dir
            ])
            await load()
            return true
        } catch {
            fail(dir, operation: label, error)
            return false
        }
    }

    private func fail(_ dir: String, operation: String, _ error: Error) {
        operationError = OperationError(dir: dir, message: error.localizedDescription)
        DiagnosticLog.log("projects: operation failed", tag: "admin.projects", level: .warn, fields: [
            "server_id": serverId, "operation": operation, "dir": dir, "error": error.localizedDescription
        ])
    }
}
