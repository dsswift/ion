import Foundation

/// The Projects page's calls: the server's project registry, its background
/// jobs, and its folder browser.
extension ServerAdminClient {

    func listProjects() async throws -> [EnvironmentProject] {
        try await call(.environmentProjectsList)
    }

    func listJobs() async throws -> [EnvironmentJob] {
        try await call(.environmentJobsList)
    }

    /// Registers a folder already on the server's host.
    func addProject(dir: String) async throws -> EnvironmentProject {
        try await call(.environmentProjectsAdd, fields: ["dir": .string(dir)])
    }

    /// Clones `url` under `parentDir` on the server as a job.
    func cloneProject(url: String, parentDir: String, name: String? = nil) async throws -> ProjectCloneStarted {
        var fields: [String: JSONValue] = ["url": .string(url), "parentDir": .string(parentDir)]
        if let name, !name.isEmpty { fields["name"] = .string(name) }
        return try await call(.environmentProjectsClone, fields: fields)
    }

    func appraiseRemoval(dir: String) async throws -> ProjectRemovalAppraisal {
        try await call(.environmentProjectsAppraiseRemoval, fields: ["dir": .string(dir)])
    }

    /// Forgets the project; with `deleteFiles` also deletes a checkout Ion cloned.
    func removeProject(dir: String, deleteFiles: Bool = false, force: Bool = false) async throws {
        var fields: [String: JSONValue] = ["dir": .string(dir)]
        if deleteFiles { fields["deleteFiles"] = .bool(true) }
        if force { fields["force"] = .bool(true) }
        // Deleting a large checkout takes as long as the disk needs.
        try await callVoid(.environmentProjectsRemove, fields: fields, timeoutSeconds: 180)
    }

    func relocateProject(from: String, to: String) async throws -> EnvironmentProject {
        // A move across filesystems copies the whole checkout.
        try await call(.environmentProjectsRelocate, fields: ["from": .string(from), "to": .string(to)], timeoutSeconds: 300)
    }

    func trustProject(dir: String) async throws -> EnvironmentProject {
        try await call(.environmentProjectsTrust, fields: ["dir": .string(dir)])
    }

    /// Starts the project's setup recipe as a job.
    func setupProject(dir: String) async throws {
        try await callVoid(.environmentProjectsSetup, fields: ["dir": .string(dir)])
    }

    func cancelJob(id: String) async throws {
        try await callVoid(.environmentJobsCancel, fields: ["jobId": .string(id)])
    }

    /// The folders under `path` on the server's host; `~` is its home.
    func browse(path: String, showHidden: Bool) async throws -> EnvironmentFsBrowse {
        try await call(.environmentFsBrowse, fields: ["path": .string(path), "showHidden": .bool(showHidden)])
    }
}
