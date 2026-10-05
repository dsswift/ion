import Foundation
import Observation

/// One paired server the Fleet screen reads: how to call it, and how to hold
/// its connection open for the length of a read.
struct FleetSource {
    let id: String
    let label: String
    let client: ServerAdminClient
    var open: @MainActor () -> Void = {}
    var close: @MainActor () -> Void = {}
}

/// The Fleet screen: every server this phone is paired with, each asked for
/// its own report in turn, added up into totals and one row per account.
@MainActor
@Observable
final class FleetModel {

    private(set) var servers: [FleetServer] = []
    private(set) var accounts: [FleetAccountRow] = []
    private(set) var totals = FleetTotals(servers: 0, serversReached: 0, runningConversations: 0, accounts: 0, accountsSignedIn: 0)
    private(set) var loading = false

    /// Reads every server's report. With `refreshUsage`, each server first
    /// reads its provider CLIs again, so the limits are fresh. A server that
    /// does not answer keeps its last report and says why.
    func load(_ sources: [FleetSource], refreshUsage: Bool = false) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        servers = sources.map { source in
            servers.first { $0.id == source.id }.map { FleetServer(id: $0.id, label: source.label, report: $0.report, error: $0.error) }
                ?? FleetServer(id: source.id, label: source.label)
        }
        for source in sources {
            source.open()
            defer { source.close() }
            guard let index = servers.firstIndex(where: { $0.id == source.id }) else { continue }
            if refreshUsage {
                do {
                    try await source.client.refreshFleetAccounts()
                } catch {
                    DiagnosticLog.log("fleet: usage refresh failed", tag: "settings.fleet", level: .warn, fields: [
                        "server": source.label, "error": String(describing: error)
                    ])
                }
            }
            do {
                let report = try await source.client.fleetReport()
                servers[index].report = report
                servers[index].error = nil
                DiagnosticLog.log("fleet: report read", tag: "settings.fleet", level: .debug, fields: [
                    "server": source.label, "accounts": String(report.accounts.count), "refreshed": String(refreshUsage)
                ])
            } catch {
                servers[index].error = error.localizedDescription
                DiagnosticLog.log("fleet: report failed", tag: "settings.fleet", level: .warn, fields: [
                    "server": source.label, "error": String(describing: error)
                ])
            }
            summarize()
        }
        summarize()
    }

    private func summarize() {
        accounts = FleetSummary.accounts(servers)
        totals = FleetSummary.totals(servers, accounts: accounts)
    }
}
