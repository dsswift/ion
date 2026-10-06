import Foundation
import Observation

/// Add project's "New Repo" source: pick a git-host account and where under
/// it, name the repository, then create it and clone it onto the server,
/// following the clone until it is a project there.
@MainActor
@Observable
final class NewRepositoryModel {

    /// What a repository name may contain on every supported host; mirrors
    /// `GIT_REPOSITORY_NAME` in `@ion/shared/types-git-hosting`.
    private static let namePattern = #"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"#

    /// Nil until the server answered. Only accounts that can create somewhere.
    private(set) var accounts: [GitHostingAccount]?
    /// Git hosts that refused the server's token, one line each.
    private(set) var refusals: [String] = []
    /// Why the account list could not be read; nil while it loads or once it has.
    private(set) var loadError: String?
    var accountId = ""
    var ownerId = ""
    var name = ""
    var isPrivate = true
    var details = ""
    private(set) var busy = false
    private(set) var error: String?
    /// What the create-and-clone is doing now, while it runs.
    private(set) var progress: String?

    let serverId: String
    let serverLabel: String
    /// Where clones land on this server.
    let baseDir: String
    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let events: ServerAdminEvents

    init(serverId: String, serverLabel: String, client: ServerAdminClient, baseDir: String, events: ServerAdminEvents = .shared) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
        self.baseDir = CloneBaseDirectory.normalized(baseDir)
        self.events = events
    }

    // MARK: - Selection

    /// The chosen account, or the first when none was chosen.
    var account: GitHostingAccount? { accounts?.first { $0.id == accountId } ?? accounts?.first }
    /// The chosen owner under that account, or its first.
    var owner: GitHostingOwner? { account?.owners.first { $0.id == ownerId } ?? account?.owners.first }

    var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    /// Why the typed name cannot be a repository name; nil for an empty or valid one.
    var nameProblem: String? {
        let value = trimmedName
        if value.isEmpty { return nil }
        if value.range(of: Self.namePattern, options: .regularExpression) == nil { return "Use letters, digits, dots, dashes and underscores, starting with a letter or digit." }
        if value.hasSuffix(".git") || value.hasSuffix(".") { return "The name cannot end with \".git\" or a dot." }
        return nil
    }

    var canCreate: Bool { !busy && owner != nil && !trimmedName.isEmpty && nameProblem == nil }

    /// Where the clone lands.
    var clonePreview: String { "\(baseDir)/\(trimmedName.isEmpty ? "<name>" : trimmedName)" }

    // MARK: - Verbs

    /// Clears a failed listing, so the loading row shows and reads the accounts again.
    func retryAccounts() {
        DiagnosticLog.log("new repository: accounts listing retried", tag: "admin.projects", fields: ["server_id": serverId])
        loadError = nil
    }

    func loadAccounts() async {
        do {
            let listed = try await client.hostingAccounts()
            accounts = listed.filter { !$0.owners.isEmpty }
            refusals = listed.compactMap { account in account.error.map { "\(account.host): \($0)" } }
            loadError = nil
            DiagnosticLog.log("new repository: accounts listed", tag: "admin.projects", fields: [
                "server_id": serverId, "accounts": String(accounts?.count ?? 0), "refused": String(refusals.count)
            ])
        } catch is CancellationError {
            return
        } catch {
            // Not "no accounts": the list was never read, so say why and offer to read it again.
            loadError = error.localizedDescription
            DiagnosticLog.log("new repository: accounts listing failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    /// Creates the repository, clones it onto the server, and waits for the
    /// clone to be registered. Returns the checkout's directory, or nil with
    /// `error` set.
    func createAndClone() async -> String? {
        guard let account, let owner else { return nil }
        busy = true
        error = nil
        defer { busy = false; progress = nil }
        // Subscribed before the clone starts, so a clone that finishes at once is still heard.
        let stream = events.events(for: serverId)
        do {
            progress = "Creating \(owner.label)/\(trimmedName)…"
            let repository = try await client.createRepository(
                host: account.host, owner: owner.id, name: trimmedName, isPrivate: isPrivate,
                description: details.trimmingCharacters(in: .whitespaces)
            )
            DiagnosticLog.log("new repository: created", tag: "admin.projects", fields: [
                "server_id": serverId, "git_host": repository.host, "owner": repository.owner, "name": repository.name
            ])
            progress = "Cloning onto \(serverLabel)…"
            // The person just made this repository, so its clone is trusted.
            let started = try await client.cloneProject(remote: repository, parentDir: baseDir, trust: true)
            return try await follow(started, in: stream)
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("new repository: failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
            return nil
        }
    }

    /// Reads the server's job snapshots until the clone `started` names is done or has failed.
    private func follow(_ started: ProjectCloneStarted, in stream: AsyncStream<ServerAdminEvent>) async throws -> String {
        for await event in stream where event.channel == ServerAdminEvent.projectJob {
            let job: EnvironmentJob
            do {
                job = try event.payload.decoded(as: EnvironmentJob.self)
            } catch {
                DiagnosticLog.log("new repository: job event did not decode", tag: "admin.projects", level: .warn, fields: [
                    "server_id": serverId, "error": String(String(describing: error).prefix(300))
                ])
                continue
            }
            guard job.id == started.jobId else { continue }
            switch job.phase {
            case .running:
                progress = job.percent.map { "Cloning: \(job.stage) \(Int($0))%" } ?? "Cloning: \(job.stage)"
            case .done:
                DiagnosticLog.log("new repository: cloned", tag: "admin.projects", fields: ["server_id": serverId, "job_id": job.id])
                return job.dir
            case .failed, .cancelled:
                throw CloneFailure(message: job.error ?? "The clone did not finish.")
            }
        }
        throw CancellationError()
    }

    private struct CloneFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}
