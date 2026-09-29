import SwiftUI

/// Every Ion process on a server's host, by role, heaviest first within a
/// role, with its CPU and memory. Refreshes while on screen.
struct ServerProcessesView: View {
    let model: HealthAdminModel

    var body: some View {
        List {
            if let metrics = model.metrics {
                Section {
                    ForEach(metrics.sortedProcesses) { process in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(process.name).lineLimit(1)
                                Text(process.role).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(Self.cpu(process.cpuPercent)).monospacedDigit()
                                Text(HostMetricsSummary.bytes(process.rssBytes))
                                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                } footer: {
                    Text("CPU is a share of one core: 100% is one full core.")
                }
            } else if let error = model.metricsError {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Waiting for the first sample…").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Processes")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .task { await model.poll() }
    }

    static func cpu(_ percent: Double?) -> String {
        guard let percent else { return "–" }
        return "\(Int(percent.rounded()))%"
    }
}
