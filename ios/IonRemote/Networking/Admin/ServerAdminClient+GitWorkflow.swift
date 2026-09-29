import Foundation

/// The git workflow section's calls: the saved source branch per directory,
/// which lives in this person's settings on the server and has no projected row.
extension ServerAdminClient {

    /// Directory → saved source branch.
    func worktreeBranchDefaults() async throws -> [String: String] {
        let settings = try await callValue(.settingsLoad)
        return try member("worktreeBranchDefaults", of: settings, from: .settingsLoad, as: [String: String]?.self) ?? [:]
    }

    /// Replaces the whole map.
    func saveWorktreeBranchDefaults(_ defaults: [String: String]) async throws {
        try await callVoid(.settingsSave, args: [.object(["worktreeBranchDefaults": .object(defaults.mapValues(JSONValue.string))])])
    }
}
