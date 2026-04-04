import SwiftUI

struct SettingsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showPairing = false

    var body: some View {
        NavigationStack {
            List {
                connectionSection
                newTabSection
                pairedDevicesSection
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showPairing) {
                PairingView()
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    showPairing = true
                } label: {
                    Text("Pair New Device")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(hex: 0x4ECDC4))
                .padding()
            }
        }
    }

    private var statusLabel: String {
        guard viewModel.connectionState == .connected else {
            return viewModel.connectionState.label
        }
        switch viewModel.transportState {
        case .lanPreferred: return "Connected (LAN)"
        case .relayOnly: return "Connected (Relay)"
        case .disconnected: return "Connected"
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var connectionSection: some View {
        Section("Connection") {
            HStack {
                Text("Status")
                Spacer()
                HStack(spacing: 6) {
                    Circle()
                        .fill(viewModel.connectionState.color)
                        .frame(width: 8, height: 8)
                    Text(statusLabel)
                        .foregroundStyle(.secondary)
                }
            }

            HStack {
                Text("Relay URL")
                Spacer()
                Text(viewModel.relayURL.isEmpty ? "Not configured" : viewModel.relayURL)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private var newTabSection: some View {
        Section("New Tab") {
            Picker("Default Directory", selection: Binding<String?>(
                get: { viewModel.defaultBaseDirectory },
                set: { viewModel.defaultBaseDirectory = $0 }
            )) {
                Text("None (desktop default)").tag(nil as String?)
                ForEach(viewModel.recentDirectories, id: \.self) { dir in
                    Text((dir as NSString).lastPathComponent).tag(dir as String?)
                }
            }
        }
    }

    private var pairedDevicesSection: some View {
        Section("Paired Devices") {
            if viewModel.pairedDevices.isEmpty {
                Text("No paired devices")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(viewModel.pairedDevices) { device in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(device.name)
                            .font(.headline)
                        Text("Paired \(device.pairedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let lastSeen = device.lastSeen {
                            Text("Last seen \(lastSeen.formatted(.relative(presentation: .named)))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .onDelete { offsets in
                    let devices = offsets.map { viewModel.pairedDevices[$0] }
                    for device in devices {
                        viewModel.unpairDevice(device)
                    }
                }
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
            HStack {
                Text("Version")
                Spacer()
                Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                    .foregroundStyle(.secondary)
            }

            Button(role: .destructive) {
                viewModel.resetAll()
            } label: {
                Text("Reset Connection & Pairing")
            }
        }
    }
}
