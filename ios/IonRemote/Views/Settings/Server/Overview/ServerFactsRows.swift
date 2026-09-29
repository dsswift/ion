import SwiftUI

/// The server, engine, and host behind one server, as rows.
struct ServerFactsRows: View {
    let info: EnvironmentServerInfo

    var body: some View {
        LabeledContent("Server version", value: info.serverVersion)
        LabeledContent("Engine") {
            VStack(alignment: .trailing, spacing: 2) {
                Text(info.engineVersion ?? "Not connected")
                if info.engineMeetsMin == false, let minimum = info.engineMinVersion {
                    Text("Below the minimum \(minimum)")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        LabeledContent("Host", value: "\(info.hostname) · \(info.platform)/\(info.arch)")
        VStack(alignment: .leading, spacing: 4) {
            Text("Data directory")
            Text(info.dataDir)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        LabeledContent("Installed as", value: Self.installedAs(info))
        LabeledContent("Up for", value: Self.uptime(info.uptimeSeconds))
        if info.hostApp != nil || info.runningConversations != nil {
            LabeledContent("Run by", value: info.hostApp.map { "Ion desktop \($0.version)" } ?? "Its own service")
            LabeledContent("Running now", value: Self.running(info.runningConversations))
        }
    }

    static func installedAs(_ info: EnvironmentServerInfo) -> String {
        guard let bundle = info.bundle else { return "Not a bundle install" }
        return "Bundle \(bundle.version.server)"
    }

    static func uptime(_ seconds: Double) -> String {
        Duration.seconds(max(0, seconds)).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated, maximumUnitCount: 2))
    }

    static func running(_ count: Int?) -> String {
        guard let count else { return "Engine not answering" }
        return count == 1 ? "1 conversation" : "\(count) conversations"
    }
}
