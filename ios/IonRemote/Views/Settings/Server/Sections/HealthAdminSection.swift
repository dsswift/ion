import SwiftUI

/// The Health page's rows: host load, then the processes, host tools,
/// telemetry delivery, and logs, each opening its own screen. Refreshes on a
/// timer only while the page is on screen.
struct HealthAdminSection: View {
    let session: ServerAdminSession

    @State private var model: HealthAdminModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: HealthAdminModel(client: session.client))
    }

    var body: some View {
        summary
        // The timer rides a row that is always present: a modifier on a view
        // of several rows applies to each row.
        NavigationLink {
            ServerProcessesView(model: model)
        } label: {
            LabeledContent("Processes", value: model.metrics.map { String($0.processes.count) } ?? "")
        }
        .task { await model.poll() }
        .reloadsWithServerPage("health") { [model] in await model.refresh() }
        NavigationLink {
            HostToolsView(model: model)
        } label: {
            LabeledContent("Tools on the host", value: toolsDetail)
        }
        if !model.telemetry.isEmpty {
            NavigationLink {
                TelemetryDeliveryView(model: model)
            } label: {
                LabeledContent("Telemetry delivery", value: telemetryDetail)
            }
        }
        ForEach(EnvironmentLogTail.File.allCases) { file in
            NavigationLink {
                ServerLogTailView(client: session.client, file: file)
            } label: {
                LabeledContent(file.fileName, value: "Last \(LogTailModel.lineCount) lines")
            }
            .disabled(!session.allows(.environmentServerLogTail))
        }
        if let reason = session.denialReason(.environmentServerLogTail) {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var summary: some View {
        if let metrics = model.metrics {
            HostMetricsSummary(metrics: metrics, cpuHistory: model.cpuHistory)
        } else if let error = model.metricsError {
            Label("Metrics unavailable: \(error)", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
        } else if model.metricsLoaded {
            Text("\(session.serverLabel) has not taken a sample yet.")
                .foregroundStyle(.secondary)
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text("Waiting for the first sample…").foregroundStyle(.secondary)
            }
        }
    }

    private var toolsDetail: String {
        guard model.tools != nil else { return model.toolsError == nil ? "" : "Unavailable" }
        let missing = model.missingTools.count
        return missing == 0 ? "All installed" : "\(missing) missing"
    }

    /// The worst state across targets.
    private var telemetryDetail: String {
        let targets = model.telemetry
        if let bad = targets.first(where: { $0.critical }) ?? targets.first(where: { $0.stuck }) ?? targets.first(where: { !$0.healthy }) {
            return bad.statusLabel
        }
        return "Delivering"
    }
}
