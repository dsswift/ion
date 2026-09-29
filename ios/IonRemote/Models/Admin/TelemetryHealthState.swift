import Foundation

/// The delivery health of one telemetry target on a server. Mirrors
/// `TelemetryHealthState` in `packages/shared/src/types-telemetry-health.ts`;
/// only the fields the phone shows are read.
struct TelemetryHealthState: Decodable, Equatable, Sendable, Identifiable {
    let target: String
    let queuedEvents: Int
    let queuedBytes: Double
    let healthy: Bool
    let critical: Bool
    let stuck: Bool
    let lastError: String?
    var id: String { target }

    /// One word for the state, as the server's desktop client names it.
    var statusLabel: String {
        if critical { return "Critical" }
        if stuck { return "Stuck" }
        return healthy ? "Delivering" : "Backlogged"
    }
}
