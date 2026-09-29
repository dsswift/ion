import Foundation
import Observation

/// The Health page of one server: host load, the Ion processes on it, its
/// developer tools, and telemetry delivery. Refreshed on a timer only while a
/// Health screen is on screen.
@MainActor
@Observable
final class HealthAdminModel {

    /// How often a visible Health screen reads a new sample. The server's
    /// background sampling runs every ten seconds, so faster reads repeat it.
    static let refreshInterval: Duration = .seconds(10)
    /// The CPU history window drawn under the meters.
    static let historyWindowSeconds = 15 * 60

    private(set) var metrics: EnvironmentSystemMetrics?
    private(set) var telemetry: [TelemetryHealthState] = []
    /// Host CPU over the history window, 0...1, oldest first.
    private(set) var cpuHistory: [Double] = []
    /// True once the first metrics read answered, sample or not.
    private(set) var metricsLoaded = false
    private(set) var metricsError: String?
    private(set) var tools: EnvironmentToolchains?
    private(set) var toolsError: String?

    @ObservationIgnored private let client: ServerAdminClient

    init(client: ServerAdminClient) {
        self.client = client
    }

    var serverLabel: String { client.serverLabel }
    var logClient: ServerAdminClient { client }

    var missingTools: [EnvironmentToolchains.Tool] { tools?.tools.filter { !$0.installed } ?? [] }

    /// Reads the newest sample, the CPU history, and (once) the host's tools.
    func refresh() async {
        async let latestRead = client.systemMetricsLatest()
        async let historyRead = client.systemMetricsHistory(windowSeconds: Self.historyWindowSeconds)
        do {
            let latest = try await latestRead
            metrics = latest.latest
            telemetry = latest.telemetryHealth.sorted { $0.target < $1.target }
            metricsError = nil
            DiagnosticLog.log("health: sample read", tag: "settings.health", level: .debug, fields: [
                "server": client.serverLabel, "has_sample": String(latest.latest != nil),
                "processes": String(latest.latest?.processes.count ?? 0), "telemetry_targets": String(latest.telemetryHealth.count)
            ])
        } catch {
            metricsError = error.localizedDescription
            DiagnosticLog.log("health: sample read failed", tag: "settings.health", level: .warn, fields: [
                "server": client.serverLabel, "error": String(describing: error)
            ])
        }
        metricsLoaded = true
        do {
            cpuHistory = try await historyRead.cpuSeries
        } catch {
            // The meters still show; only the history line is missing.
            DiagnosticLog.log("health: history read failed", tag: "settings.health", level: .warn, fields: [
                "server": client.serverLabel, "error": String(describing: error)
            ])
        }
        if tools == nil { await loadTools() }
    }

    /// Refreshes now and every `refreshInterval` until the calling task is cancelled.
    func poll() async {
        while !Task.isCancelled {
            await refresh()
            do {
                try await Task.sleep(for: Self.refreshInterval)
            } catch {
                return // cancelled: the screen left
            }
        }
    }

    private func loadTools() async {
        do {
            tools = try await client.hostToolchains()
            toolsError = nil
        } catch {
            toolsError = error.localizedDescription
            DiagnosticLog.log("health: tools probe failed", tag: "settings.health", level: .warn, fields: [
                "server": client.serverLabel, "error": String(describing: error)
            ])
        }
    }
}
