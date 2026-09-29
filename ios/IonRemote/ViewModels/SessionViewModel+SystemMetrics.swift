import Foundation

/// The connected Environment's load, held as one value so it can live in an
/// extension of the observable view model (see `PresenceUIState` for the same
/// pattern).
struct SystemMetricsUIState {
    /// The latest summary from the connected Environment, or nil before the
    /// first one and after the phone stops watching.
    var summary: EnvironmentLoadSummary?
}

extension SessionViewModel {

    var environmentLoad: EnvironmentLoadSummary? {
        systemMetricsUI.summary
    }

    /// Replace the summary. Each push is complete; nothing is merged.
    func handleSystemMetrics(_ summary: EnvironmentLoadSummary) {
        systemMetricsUI.summary = summary
        DiagnosticLog.log("environment load updated", tag: "system-metrics", level: .debug, fields: [
            "cpu": summary.cpuUtilization.map { String(format: "%.2f", $0) } ?? "nil",
            "memory": summary.memoryUsedFraction.map { String(format: "%.2f", $0) } ?? "nil",
        ])
    }

    /// Ask the connected Environment for its load summary. A watch belongs to
    /// one connection on the server, so this runs on every connect.
    func startSystemMetricsWatch() {
        DiagnosticLog.log("system metrics watch started", tag: "system-metrics")
        send(.systemMetricsWatch(on: true), intent: .automaticFireAndForget)
    }

    /// Stop the summary before the app backgrounds, and drop the last value so
    /// a stale load is never shown on return.
    func stopSystemMetricsWatch() {
        DiagnosticLog.log("system metrics watch stopped", tag: "system-metrics")
        send(.systemMetricsWatch(on: false), intent: .automaticFireAndForget)
        systemMetricsUI.summary = nil
    }

    /// Forget the summary without a send: the connection it came from is gone.
    func clearEnvironmentLoad() {
        if systemMetricsUI.summary != nil {
            DiagnosticLog.log("environment load cleared", tag: "system-metrics", level: .debug)
        }
        systemMetricsUI.summary = nil
    }

    /// "CPU 23% · Memory 61%" for the picker row, or nil when nothing is known.
    static func loadLabel(_ summary: EnvironmentLoadSummary?) -> String? {
        guard let summary else { return nil }
        var parts: [String] = []
        if let cpu = summary.cpuUtilization { parts.append("CPU \(Int((cpu * 100).rounded()))%") }
        if let mem = summary.memoryUsedFraction { parts.append("Memory \(Int((mem * 100).rounded()))%") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
