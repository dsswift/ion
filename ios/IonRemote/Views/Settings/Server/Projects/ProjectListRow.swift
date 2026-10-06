import Foundation

/// One row of the Projects list: a project (with any job still running on
/// it), or a job that has no project yet (a clone running, a clone that
/// failed).
enum ProjectListRow: Identifiable, Equatable, Sendable {
    case job(EnvironmentJob)
    case project(EnvironmentProject, job: EnvironmentJob?)

    var id: String {
        switch self {
        case .job(let job): return "job:\(job.id)"
        case .project(let project, _): return project.dir
        }
    }

    var status: ProjectRowStatus {
        switch self {
        case .job(let job): return .of(job)
        case .project(let project, let job): return .of(project, job: job)
        }
    }

    var name: String {
        switch self {
        case .job(let job): return Self.name(of: job)
        case .project(let project, _): return project.displayName
        }
    }

    /// Job rows first (running jobs whose folder is not a project yet, then
    /// failed clones and creates), then every project by name. A running job
    /// whose folder is a project rides on that project's row. One folder
    /// shows one running job: a create, which carries its own clone's
    /// progress, over the clone or setup it started.
    static func build(projects: [EnvironmentProject], jobs: [EnvironmentJob]) -> [ProjectListRow] {
        let running = jobs.filter { $0.phase == .running }
        let shown = running.filter { job in
            job.kind == .create || !running.contains { $0.kind == .create && $0.dir == job.dir }
        }
        let failed = jobs.filter { $0.phase == .failed && ($0.kind == .clone || $0.kind == .create) }
        let dirs = Set(projects.map(\.dir))
        let jobRows = (shown.filter { !dirs.contains($0.dir) } + failed).map(ProjectListRow.job)
        let projectRows = projects
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .map { project in ProjectListRow.project(project, job: shown.first { $0.dir == project.dir }) }
        return jobRows + projectRows
    }

    /// The search filter: a project by name, path, or branch; a job by name,
    /// folder, or URL.
    func matches(_ query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return true }
        let fields: [String]
        switch self {
        case .job(let job): fields = [Self.name(of: job), job.dir, job.url ?? ""]
        case .project(let project, _): fields = [project.displayName, project.dir, project.branch ?? ""]
        }
        return fields.contains { $0.lowercased().contains(needle) }
    }

    /// The folder a clone of `url` lands in: its last path segment without `.git`.
    static func repoName(fromURL url: String) -> String {
        var trimmed = url.trimmingCharacters(in: .whitespaces)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let last = trimmed.split(whereSeparator: { $0 == "/" || $0 == ":" }).last.map(String.init) ?? ""
        return last.hasSuffix(".git") ? String(last.dropLast(4)) : last
    }

    static func baseName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    static func name(of job: EnvironmentJob) -> String {
        let fromURL = job.url.map(repoName(fromURL:)) ?? ""
        return fromURL.isEmpty ? baseName(job.dir) : fromURL
    }
}
