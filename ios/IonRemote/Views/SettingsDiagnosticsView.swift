import SwiftUI

struct SettingsDiagnosticsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section("Diagnostics") {
                HStack {
                    Label("Transport", systemImage: "antenna.radiowaves.left.and.right")
                    Spacer()
                    Text(transportLabel)
                        .foregroundStyle(.secondary)
                }
                if let latency = viewModel.connectionQuality.latencyLabel {
                    HStack {
                        Label("Latency", systemImage: "timer")
                        Spacer()
                        Text(latency)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Label("Buffered", systemImage: "tray.full")
                    Spacer()
                    Text("\(viewModel.connectionQuality.lastBuffered)")
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Label("Signal", systemImage: "wifi")
                    Spacer()
                    Text(viewModel.connectionQuality.signalLevel.label)
                        .foregroundStyle(.secondary)
                }
            }

            Section("About") {
                HStack {
                    Spacer()
                    VStack(spacing: 8) {
                        Image(systemName: "bolt.shield.fill")
                            .font(.system(size: 40)) // design-type: SF Symbol hero glyph sized as icon geometry, not text
                            .foregroundStyle(theme.accent)
                        Text("Ion Remote")
                            .font(.headline)
                        Text(appVersionString)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .listRowBackground(Color.clear)

                NavigationLink("Diagnostic Log") {
                    DiagnosticLogView()
                }

                Button(role: .destructive) {
                    dismiss()
                    viewModel.resetAll()
                } label: {
                    HStack {
                        Spacer()
                        Text("Unpair All Devices")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                    }
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Diagnostics & About")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var transportLabel: String {
        switch viewModel.transportState {
        case .lanPreferred: return "LAN (Bonjour)"
        case .relayOnly: return "Relay (WebSocket)"
        case .disconnected: return "Disconnected"
        }
    }

    private var appVersionString: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        let hash = info?["IonBuildHash"] as? String ?? "?"
        return "v\(version) (\(build).\(hash))"
    }
}
