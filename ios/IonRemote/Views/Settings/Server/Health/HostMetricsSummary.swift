import SwiftUI

/// Host CPU, memory, and disk as three static meters, the CPU count and
/// load, and the CPU history line. Nothing here animates; it redraws only
/// when a sample arrives.
struct HostMetricsSummary: View {
    let metrics: EnvironmentSystemMetrics
    let cpuHistory: [Double]

    var body: some View {
        let host = metrics.host
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 16) {
                MetricMeter(label: "CPU", fraction: host.cpuUtilization, value: Self.percent(host.cpuUtilization))
                MetricMeter(label: "Memory", fraction: host.memoryUsedFraction, value: "\(Self.bytes(host.memoryUsedBytes)) of \(Self.bytes(host.memoryCeilingBytes))")
                MetricMeter(label: "Disk", fraction: host.diskUsedFraction, value: "\(Self.bytes(host.diskFreeBytes)) free")
            }
            Text(Self.cpuLine(host))
                .font(.caption)
                .foregroundStyle(.secondary)
            if cpuHistory.count >= 2 {
                CPUHistoryLine(values: cpuHistory)
                    .frame(height: 28)
                    .accessibilityLabel("Host CPU over the last 15 minutes")
            }
        }
        .padding(.vertical, IonSpace.hairlineGap)
    }

    static func cpuLine(_ host: EnvironmentSystemMetrics.Host) -> String {
        let cpus = host.cpus.rounded() == host.cpus ? String(Int(host.cpus)) : String(format: "%.1f", host.cpus)
        var text = "\(cpus) CPUs"
        if let load = host.load1 { text += " · load \(String(format: "%.2f", load))" }
        if host.containerLimited { text += " · container limit" }
        return text
    }

    static func percent(_ fraction: Double?) -> String {
        guard let fraction else { return "–" }
        return "\(Int((fraction * 100).rounded()))%"
    }

    static func bytes(_ count: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .memory)
    }
}
