import SwiftUI

/// Whether each telemetry target on a server is delivering, and what is queued.
struct TelemetryDeliveryView: View {
    let model: HealthAdminModel

    var body: some View {
        List {
            ForEach(model.telemetry) { target in
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent(target.target, value: target.statusLabel)
                    if target.queuedEvents > 0 {
                        Text("\(target.queuedEvents) queued · \(HostMetricsSummary.bytes(target.queuedBytes))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = target.lastError, !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(.orange)
                    }
                }
            }
        }
        .navigationTitle("Telemetry delivery")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
    }
}
