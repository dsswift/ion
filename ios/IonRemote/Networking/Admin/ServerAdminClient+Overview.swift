import Foundation

// MARK: - Overview
//
// The server's facts and the verbs that act on its services: restart,
// update, and uninstall (`server/src/environment/actions.ts`).

extension ServerAdminClient {

    func serverInfo() async throws -> EnvironmentServerInfo {
        try await call(.environmentServerInfo)
    }

    /// Schedules `ion studio restart` on the host. Refused when the server was
    /// not installed from a bundle.
    func restartServer() async throws {
        try await callVoid(.environmentServerRestart)
    }

    /// Schedules `ion studio update --yes` on the host. Refused when the server
    /// was not installed from a bundle.
    func updateServer() async throws {
        try await callVoid(.environmentServerUpdate)
    }

    func purgeAppraise() async throws -> EnvironmentPurgeAppraisal {
        try await call(.environmentPurgeAppraise, timeoutSeconds: 60)
    }

    /// Uninstalls Ion from the host to the degree `levels` names.
    func purgeRun(_ levels: EnvironmentPurgeLevels) async throws -> EnvironmentPurgeResult {
        try await call(.environmentPurgeRun, fields: levels.fields, timeoutSeconds: 180)
    }
}
