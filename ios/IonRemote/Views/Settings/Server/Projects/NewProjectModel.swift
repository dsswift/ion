import Foundation
import Observation

/// The New Project card: a repository on a git host, its clone on the
/// connected server, and a conversation opened in it on a chosen model and
/// sent the opening prompt. The server does all of it as one `create` job
/// (`gitHosting.startProject`), so the card may close at any point and the
/// server still finishes. While the card is open it follows the job and
/// hands back the conversation the job opened.
@MainActor
@Observable
final class NewProjectModel {

    /// The account, owner, name, and visibility, with their checks.
    let repository: NewRepositoryModel
    /// The opening prompt; empty opens the conversation without one.
    var prompt = ""
    /// The model the conversation starts on; nil keeps the server's default.
    private(set) var modelId: String?
    private(set) var providerId: String?
    /// The engine profile that hosts the conversation; nil opens a plain one.
    var profileId: String?
    /// The server's default for a plain conversation; nil until read.
    private(set) var plainDefaultModel: String?
    /// The server's default for an engine-hosted conversation; empty falls back to the plain one.
    private(set) var engineDefaultModel = ""
    private(set) var busy = false
    /// What the job is doing now, while it runs.
    private(set) var progress: String?
    private(set) var error: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let events: ServerAdminEvents
    /// The id the server keeps this project's progress under, and the
    /// repository it was for. A retry for the same repository reuses it, so
    /// the server resumes; a different repository gets a new one.
    @ObservationIgnored private var attempt: (requestId: String, repository: String)?
    /// The job being followed.
    @ObservationIgnored private var jobId: String?

    init(serverId: String, serverLabel: String, client: ServerAdminClient, baseDir: String, events: ServerAdminEvents = .shared) {
        self.client = client
        self.events = events
        repository = NewRepositoryModel(serverId: serverId, serverLabel: serverLabel, client: client, baseDir: baseDir, events: events)
    }

    var serverId: String { repository.serverId }
    var canStart: Bool { !busy && repository.canCreate }

    /// The model the conversation starts on when none is picked.
    var defaultModelId: String {
        if profileId != nil, !engineDefaultModel.isEmpty { return engineDefaultModel }
        return plainDefaultModel ?? ""
    }

    /// The picked model, or the default.
    var effectiveModelId: String { modelId ?? defaultModelId }

    // MARK: - Verbs

    /// Reads the server's default models, for the model row's label.
    func loadDefaults() async {
        do {
            let settings = try await client.loadSettings()
            plainDefaultModel = settings["preferredModel"]?.stringValue ?? ""
            engineDefaultModel = settings["engineDefaultModel"]?.stringValue ?? ""
        } catch is CancellationError {
            return
        } catch {
            plainDefaultModel = ""
            DiagnosticLog.log("new project: default models not read", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    /// A pick from the model picker. An empty `modelId` is its "server default" row.
    func pickModel(_ modelId: String, providerId: String) {
        self.modelId = modelId.isEmpty ? nil : modelId
        self.providerId = modelId.isEmpty || providerId.isEmpty ? nil : providerId
    }

    /// Asks the server to make the project, then follows its job. Returns
    /// the conversation the job opened, or nil with `error` set.
    func start() async -> String? {
        guard canStart, let account = repository.account, let owner = repository.owner else { return nil }
        let name = repository.trimmedName
        let key = [account.id, owner.id, name, String(repository.isPrivate)].joined(separator: "|")
        let requestId = attempt.flatMap { $0.repository == key ? $0.requestId : nil } ?? UUID().uuidString
        attempt = (requestId, key)
        busy = true
        error = nil
        defer { busy = false; progress = nil; jobId = nil }
        // Subscribed before the request, so a job that finishes at once is still heard.
        let stream = events.events(for: serverId)
        do {
            progress = "Starting…"
            let started = try await client.startProject(ServerAdminClient.ProjectStart(
                requestId: requestId, host: account.host, owner: owner.id, name: name, isPrivate: repository.isPrivate,
                parentDir: repository.baseDir, prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                model: modelId, providerId: providerId, profileId: profileId
            ))
            jobId = started.jobId
            DiagnosticLog.log("new project: started", tag: "admin.projects", fields: [
                "server_id": serverId, "job_id": started.jobId, "request_id": requestId, "git_host": account.host,
                "model": modelId ?? "default", "profile_id": profileId ?? "plain"
            ])
            return try await follow(started.jobId, in: stream)
        } catch is CancellationError {
            DiagnosticLog.log("new project: stopped following; the server carries on", tag: "admin.projects", fields: [
                "server_id": serverId, "request_id": requestId
            ])
            return nil
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("new project: failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "request_id": requestId, "error": error.localizedDescription
            ])
            return nil
        }
    }

    /// Re-reads the followed job from the server and replays it, for a card
    /// that came back from the background after its events were missed.
    func resync() async {
        guard let jobId else { return }
        do {
            let jobs: [JSONValue] = try await client.call(.environmentJobsList)
            let ours = jobs.first { job in
                if case .object(let fields) = job { return fields["id"] == .string(jobId) }
                return false
            }
            guard let ours else {
                DiagnosticLog.log("new project: resync found no job", tag: "admin.projects", level: .warn, fields: ["server_id": serverId, "job_id": jobId])
                return
            }
            events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.projectJob, payload: ours))
            DiagnosticLog.log("new project: resynced", tag: "admin.projects", fields: ["server_id": serverId, "job_id": jobId])
        } catch {
            DiagnosticLog.log("new project: resync failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "job_id": jobId, "error": error.localizedDescription
            ])
        }
    }

    /// Reads the server's job snapshots until the job is done or has failed.
    private func follow(_ jobId: String, in stream: AsyncStream<ServerAdminEvent>) async throws -> String {
        for await event in stream where event.channel == ServerAdminEvent.projectJob {
            let job: EnvironmentJob
            do {
                job = try event.payload.decoded(as: EnvironmentJob.self)
            } catch {
                DiagnosticLog.log("new project: job event did not decode", tag: "admin.projects", level: .warn, fields: [
                    "server_id": serverId, "error": String(String(describing: error).prefix(300))
                ])
                continue
            }
            guard job.id == jobId else { continue }
            switch job.phase {
            case .running:
                let stage = job.stage.prefix(1).uppercased() + job.stage.dropFirst()
                progress = job.percent.map { "\(stage) \(Int($0))%" } ?? "\(stage)…"
            case .done:
                guard let tabId = job.tabId else { throw StartFailure(message: "The project is ready, but the server did not say which conversation it opened.") }
                DiagnosticLog.log("new project: done", tag: "admin.projects", fields: ["server_id": serverId, "job_id": jobId, "tab_id": String(tabId.prefix(8))])
                return tabId
            case .failed, .cancelled:
                throw StartFailure(message: job.error ?? "The project was not finished.")
            }
        }
        throw CancellationError()
    }

    private struct StartFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}
