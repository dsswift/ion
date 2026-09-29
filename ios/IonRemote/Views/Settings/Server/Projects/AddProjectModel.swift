import Foundation
import Observation

/// Add project for one server: register a folder already there, clone a git
/// URL there, or clone the projects the phone's other servers have that it
/// lacks.
@MainActor
@Observable
final class AddProjectModel {

    enum Source: String, CaseIterable, Identifiable {
        case folder, url, copy
        var id: String { rawValue }
    }

    var source: Source = .folder
    var url = ""
    private(set) var busy = false
    private(set) var error: String?
    /// Nil until the other servers answered.
    private(set) var candidates: [ProjectCopyCandidate]?
    /// Why some other server could not be listed, one line per server.
    private(set) var sourceFailures: [String] = []
    var ticked: Set<String> = []

    let serverId: String
    let serverLabel: String
    /// Where clones land on this server.
    let baseDir: String
    @ObservationIgnored private let client: ServerAdminClient

    init(serverId: String, serverLabel: String, client: ServerAdminClient, baseDir: String) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
        self.baseDir = CloneBaseDirectory.normalized(baseDir)
    }

    /// Where a clone of the typed URL lands.
    var clonePreview: String {
        let name = ProjectListRow.repoName(fromURL: url)
        return "\(baseDir)/\(name.isEmpty ? "<name>" : name)"
    }

    var canClone: Bool { !busy && !url.trimmingCharacters(in: .whitespaces).isEmpty }

    // MARK: - Verbs

    func addFolder(_ path: String) async -> Bool {
        await finish("folder added") {
            _ = try await $0.addProject(dir: path)
        }
    }

    func cloneURL() async -> Bool {
        let target = url.trimmingCharacters(in: .whitespaces)
        return await finish("clone started") {
            _ = try await $0.cloneProject(url: target, parentDir: baseDir)
        }
    }

    /// Lists every other server's projects and keeps the ones this server
    /// lacks by repository remote, one per remote, all ticked.
    func loadCandidates(from sources: [PairedServerSource], existing: [EnvironmentProject]) async {
        let existingRemotes = Set(existing.compactMap(\.entry.repoRemote))
        var failures: [String] = []
        var lists: [(PairedServerSource, [EnvironmentProject])] = []
        for source in sources {
            do {
                lists.append((source, try await source.client.listProjects()))
            } catch is CancellationError {
                return
            } catch {
                failures.append("\(source.label): \(error.localizedDescription)")
                DiagnosticLog.log("add project: copy source listing failed", tag: "admin.projects", level: .warn, fields: [
                    "server_id": serverId, "source_server_id": source.serverId, "error": error.localizedDescription
                ])
            }
        }
        var seen = Set<String>()
        var found: [ProjectCopyCandidate] = []
        for (source, projects) in lists {
            for project in projects {
                guard let remote = project.entry.repoRemote, let cloneURL = project.copySourceURL,
                      !existingRemotes.contains(remote), !seen.contains(remote) else { continue }
                seen.insert(remote)
                found.append(ProjectCopyCandidate(sourceLabel: source.label, project: project, remote: remote, cloneURL: cloneURL))
            }
        }
        candidates = found
        sourceFailures = failures
        ticked = Set(found.map(\.remote))
        DiagnosticLog.log("add project: copy candidates listed", tag: "admin.projects", fields: [
            "server_id": serverId, "sources": String(sources.count), "candidates": String(found.count), "failed_sources": String(failures.count)
        ])
    }

    func toggle(_ candidate: ProjectCopyCandidate) {
        if ticked.contains(candidate.remote) { ticked.remove(candidate.remote) } else { ticked.insert(candidate.remote) }
    }

    /// Starts a clone for every ticked candidate, in list order.
    func cloneTicked() async -> Bool {
        let chosen = (candidates ?? []).filter { ticked.contains($0.remote) }
        return await finish("copy clones started") { client in
            for candidate in chosen {
                _ = try await client.cloneProject(url: candidate.cloneURL, parentDir: baseDir, name: candidate.project.displayName)
            }
        }
    }

    private func finish(_ label: String, _ body: (ServerAdminClient) async throws -> Void) async -> Bool {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await body(client)
            DiagnosticLog.log("add project: done", tag: "admin.projects", fields: ["server_id": serverId, "source": source.rawValue, "operation": label])
            return true
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("add project: failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "source": source.rawValue, "error": error.localizedDescription
            ])
            return false
        }
    }
}
