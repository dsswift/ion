import Foundation
import Observation

/// One server's git access for this person: their credentials there (the
/// host's own keys and sign-ins among them) and the host's commit author.
@MainActor
@Observable
final class GitAccessModel {

    let serverId: String
    let serverLabel: String
    /// Nil until listed.
    private(set) var identities: [GitIdentitySummary]?
    private(set) var identitiesError: String?
    /// Nil until read.
    private(set) var author: EnvironmentGitAuthor?
    private(set) var authorError: String?
    private(set) var removingHost: String?
    var operationError: String?

    @ObservationIgnored private let client: ServerAdminClient

    init(serverId: String, serverLabel: String, client: ServerAdminClient) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
    }

    convenience init(session: ServerAdminSession) {
        self.init(serverId: session.serverId, serverLabel: session.serverLabel, client: session.client)
    }

    func load() async {
        async let identitiesDone: Void = loadIdentities()
        async let authorDone: Void = loadAuthor()
        _ = await (identitiesDone, authorDone)
    }

    func loadIdentities() async {
        do {
            identities = try await client.listGitIdentities()
            identitiesError = nil
        } catch is CancellationError {
            return
        } catch {
            identitiesError = error.localizedDescription
            log("credentials listing failed", error)
        }
    }

    func loadAuthor() async {
        do {
            author = try await client.gitAuthor()
            authorError = nil
        } catch is CancellationError {
            return
        } catch {
            authorError = error.localizedDescription
            log("commit author read failed", error)
        }
    }

    /// Removes this person's credential for `host` on the server.
    func remove(_ identity: GitIdentitySummary) async {
        removingHost = identity.host
        operationError = nil
        defer { removingHost = nil }
        do {
            try await client.removeGitIdentity(host: identity.host)
            DiagnosticLog.log("git access: credential removed", tag: "admin.git", fields: [
                "server_id": serverId, "git_host": identity.host
            ])
            await loadIdentities()
        } catch {
            operationError = error.localizedDescription
            log("credential removal failed", error, host: identity.host)
        }
    }

    /// Saves the commit author; returns whether it landed.
    func saveAuthor(_ next: EnvironmentGitAuthor) async -> Bool {
        do {
            author = try await client.setGitAuthor(next)
            authorError = nil
            DiagnosticLog.log("git access: commit author saved", tag: "admin.git", fields: ["server_id": serverId])
            return true
        } catch {
            authorError = error.localizedDescription
            log("commit author save failed", error)
            return false
        }
    }

    /// The empty-state sentence: the server has nothing to reach a git host with.
    var noCredentialExplanation: String {
        "\(serverLabel) has no key or sign-in for a git host, so private repositories cannot be reached until you add a credential."
    }

    private func log(_ what: String, _ error: Error, host: String? = nil) {
        var fields = ["server_id": serverId, "operation": what, "error": error.localizedDescription]
        if let host { fields["git_host"] = host }
        DiagnosticLog.log("git access: operation failed", tag: "admin.git", level: .warn, fields: fields)
    }
}
