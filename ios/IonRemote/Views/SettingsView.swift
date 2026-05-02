import SwiftUI

struct SettingsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                connectionSection
                newTabSection
                tabGroupsSection
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

    private var tabGroupsSection: some View {
        Section {
            Picker("Grouping", selection: Binding<String>(
                get: { viewModel.tabGroupMode == "manual" ? "manual" : "auto" },
                set: { newValue in viewModel.setTabGroupMode(newValue) }
            )) {
                Text("Auto (by directory)").tag("auto")
                Text("Manual (custom groups)").tag("manual")
            }

            if viewModel.tabGroupMode == "manual" {
                let sorted = viewModel.tabGroups.sorted { $0.order < $1.order }
                ForEach(sorted) { group in
                    HStack {
                        Text(group.label)
                        Spacer()
                        if group.isDefault {
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(.yellow)
                        }
                    }
                }
            }
        } header: {
            Text("Tab Groups")
        } footer: {
            if viewModel.tabGroupMode == "manual" {
                Text("Groups are managed on the desktop app. Create or rearrange groups from the desktop settings.")
            }
        }
    }

    private var pairedDevicesSection: some View {
        Section("Paired Device") {
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
                dismiss()
                viewModel.resetAll()
            } label: {
                Text("Unpair Device")
            }
        }
    }
}
