import Foundation

/// `environment.systemMetrics.latest`: the newest full sample and every
/// telemetry target's delivery health, read without starting a watch.
struct EnvironmentSystemMetricsLatest: Decodable, Equatable, Sendable {
    /// Nil before the first sample, or where the server samples nothing.
    let latest: EnvironmentSystemMetrics?
    let telemetryHealth: [TelemetryHealthState]
}
