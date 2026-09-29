import Foundation
import Observation

/// Uninstalling Ion from a server's host: what is there, which degree to
/// remove, and what the uninstall did. The server's services and bundle
/// always go; the rest is the person's choice.
@MainActor
@Observable
final class ServerPurgeModel: Identifiable {

    private(set) var appraisal: EnvironmentPurgeAppraisal?
    private(set) var appraisalError: String?
    var levels = EnvironmentPurgeLevels()
    private(set) var running = false
    private(set) var result: EnvironmentPurgeResult?
    private(set) var error: String?

    @ObservationIgnored private let client: ServerAdminClient

    init(client: ServerAdminClient) {
        self.client = client
    }

    var serverLabel: String { client.serverLabel }

    /// Only a bundle install can be uninstalled from here.
    var canRun: Bool { appraisal?.bundle != nil && !running && result == nil }

    func appraise() async {
        do {
            appraisal = try await client.purgeAppraise()
            appraisalError = nil
            DiagnosticLog.log("purge: appraised", tag: "settings.overview", fields: [
                "server": client.serverLabel,
                "clones": String(appraisal?.clonedProjects.count ?? 0),
                "bundle": String(appraisal?.bundle != nil)
            ])
        } catch {
            appraisalError = error.localizedDescription
            DiagnosticLog.log("purge: appraisal failed", tag: "settings.overview", level: .warn, fields: [
                "server": client.serverLabel, "error": String(describing: error)
            ])
        }
    }

    func run() async {
        guard canRun else { return }
        running = true
        error = nil
        defer { running = false }
        do {
            let outcome = try await client.purgeRun(levels)
            result = outcome
            DiagnosticLog.log("purge: ran", tag: "settings.overview", fields: [
                "server": client.serverLabel,
                "uninstall_scheduled": String(outcome.uninstallScheduled),
                "removed_clones": String(outcome.removedClones.count),
                "git_credentials": String(levels.gitCredentials), "data": String(levels.data)
            ])
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("purge: failed", tag: "settings.overview", level: .warn, fields: [
                "server": client.serverLabel, "error": String(describing: error)
            ])
        }
    }
}
