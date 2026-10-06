import Foundation

/// Git hosting calls: the git-host accounts a server can act as for this
/// person, creating a repository on one, and starting a whole project.
extension ServerAdminClient {

    /// What `gitHosting.startProject` is asked for.
    struct ProjectStart: Equatable, Sendable {
        /// Reused for a retry, so the server resumes at the step that failed.
        var requestId: String
        var host: String
        /// A `GitHostingOwner.id` from that host's account.
        var owner: String
        var name: String
        var isPrivate: Bool
        /// Where the clone lands on the server.
        var parentDir: String
        /// Empty opens the conversation without a prompt.
        var prompt: String
        /// Nil keeps the server's default model.
        var model: String?
        var providerId: String?
        /// Nil opens a plain conversation.
        var profileId: String?
    }

    func hostingAccounts() async throws -> [GitHostingAccount] {
        // One call per git host the server holds a token for, each to the host's own API.
        try await call(.gitHostingAccounts, timeoutSeconds: 60)
    }

    /// Creates a repository with a first commit. `owner` is a `GitHostingOwner.id` from that host's account.
    func createRepository(host: String, owner: String, name: String, isPrivate: Bool, description: String? = nil) async throws -> GitHostingRepository {
        var fields: [String: JSONValue] = [
            "host": .string(host), "owner": .string(owner), "name": .string(name),
            "visibility": .string(isPrivate ? "private" : "public")
        ]
        if let description, !description.isEmpty { fields["description"] = .string(description) }
        return try await call(.gitHostingCreateRepository, fields: fields, timeoutSeconds: 60)
    }

    /// Starts a whole project as one server job: the repository, its clone
    /// onto the server, and a conversation opened in it on `model` and sent
    /// `prompt`. The job is followed on `ion:project-job`; when done it names
    /// the conversation.
    func startProject(_ start: ProjectStart) async throws -> ProjectCloneStarted {
        var fields: [String: JSONValue] = [
            "requestId": .string(start.requestId), "host": .string(start.host), "owner": .string(start.owner),
            "name": .string(start.name), "visibility": .string(start.isPrivate ? "private" : "public"),
            "parentDir": .string(start.parentDir), "prompt": .string(start.prompt)
        ]
        if let model = start.model, !model.isEmpty { fields["model"] = .string(model) }
        if let providerId = start.providerId, !providerId.isEmpty { fields["providerId"] = .string(providerId) }
        if let profileId = start.profileId, !profileId.isEmpty { fields["profileId"] = .string(profileId) }
        return try await call(.gitHostingStartProject, fields: fields)
    }
}
