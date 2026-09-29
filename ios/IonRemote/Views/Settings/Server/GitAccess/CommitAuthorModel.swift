import Foundation
import Observation

/// Editing the commit author of one server: the global git name and email
/// on its host, optionally copied from another paired server.
@MainActor
@Observable
final class CommitAuthorModel {
    var name: String
    var email: String
    private(set) var busy = false
    private(set) var error: String?

    let serverId: String

    init(serverId: String, current: EnvironmentGitAuthor?) {
        self.serverId = serverId
        self.name = current?.name ?? ""
        self.email = current?.email ?? ""
    }

    var draft: EnvironmentGitAuthor {
        EnvironmentGitAuthor(name: name.trimmingCharacters(in: .whitespaces), email: email.trimmingCharacters(in: .whitespaces))
    }

    var canSave: Bool { !busy && draft.isSet }

    /// Fills the fields with `source`'s commit author.
    func copy(from source: PairedServerSource) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let author = try await source.client.gitAuthor()
            guard author.isSet else {
                error = "\(source.label) has no global git name and email set."
                return
            }
            name = author.name
            email = author.email
            DiagnosticLog.log("git access: commit author copied", tag: "admin.git", fields: [
                "server_id": serverId, "source_server_id": source.serverId
            ])
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("git access: commit author copy failed", tag: "admin.git", level: .warn, fields: [
                "server_id": serverId, "source_server_id": source.serverId, "error": error.localizedDescription
            ])
        }
    }

    func setError(_ message: String?) { error = message }
}
