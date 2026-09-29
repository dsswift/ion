import Foundation
import Observation

/// Test access: runs `git ls-remote` on the server for a URL and keeps the
/// latest result per URL.
@MainActor
@Observable
final class GitTestAccessModel {
    /// What the person typed; blank tests `suggestedURL`.
    var typedURL = ""
    /// The first project's origin on the server, the default to test.
    private(set) var suggestedURL: String?
    private(set) var results: [EnvironmentGitTest] = []
    private(set) var busy = false
    private(set) var error: String?

    let serverId: String
    @ObservationIgnored private let client: ServerAdminClient

    /// Results kept, newest first.
    static let keep = 5

    init(serverId: String, client: ServerAdminClient) {
        self.serverId = serverId
        self.client = client
    }

    var url: String {
        let typed = typedURL.trimmingCharacters(in: .whitespaces)
        return typed.isEmpty ? suggestedURL ?? "" : typed
    }

    /// Finds a project origin to suggest.
    func loadSuggestion() async {
        do {
            suggestedURL = try await client.listProjects().first { $0.originUrl != nil }?.originUrl
        } catch is CancellationError {
            return
        } catch {
            // Only the default URL depends on it; typing one still works.
            DiagnosticLog.log("git test: project listing for a default url failed", tag: "admin.git", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    func test() async {
        let target = url
        guard !target.isEmpty else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result = try await client.testGitAccess(url: target)
            // One result per URL: a passing retest replaces the earlier refusal.
            results = Array(([result] + results.filter { $0.url != result.url }).prefix(Self.keep))
            DiagnosticLog.log("git test: remote tested", tag: "admin.git", fields: [
                "server_id": serverId, "ok": String(result.ok)
            ])
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("git test: failed", tag: "admin.git", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }
}
