import SwiftUI

struct SettingsDesktopsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var showPairingSheet = false
    @State private var editingDevice: PairedDevice? = nil

    var body: some View {
        List {
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

            if viewModel.desktopSettings != nil, viewModel.connectionState == .connected {
                Section {
                    NavigationLink {
                        DesktopSettingsView()
                            .environment(viewModel)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "slider.horizontal.3")
                                .font(.body)
                                .foregroundStyle(theme.accent)
                                .frame(width: 28, height: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Desktop Settings")
                                    .font(.body)
                                Text(viewModel.activeDevice?.displayName ?? "Connected desktop")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: {
                    Text("Preferences for the currently-connected desktop. Each paired desktop keeps its own values.")
                }
            }

            Section {
                if viewModel.pairedDevices.isEmpty {
                    Text("No paired devices")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(viewModel.pairedDevices) { device in
                        let isActive = device.id == viewModel.activeDevice?.id
                        Button {
                            editingDevice = device
                            Haptic.light()
                        } label: {
                            HStack {
                                Image(systemName: device.displayIcon)
                                    .font(.title3)
                                    .foregroundStyle(theme.accent)
                                    .frame(width: 28, height: 28)
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 6) {
                                        Text(device.displayName)
                                            .font(.headline)
                                            .foregroundStyle(.primary)
                                        if device.customName != nil || device.customIcon != nil {
                                            Image(systemName: "pencil.circle.fill")
                                                .font(.caption2)
                                                .foregroundStyle(.tertiary)
                                                .help("Custom name/icon set")
                                        }
                                        if isActive {
                                            Text("Active")
                                                .font(.caption2)
                                                .foregroundStyle(.green)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(
                                                    Capsule().stroke(Color.green, lineWidth: 1)
                                                )
                                        }
                                    }
                                    // When a custom name is in use, show the original host
                                    // name in small text so users can still identify the
                                    // underlying machine.
                                    if let custom = device.customName?.trimmingCharacters(in: .whitespacesAndNewlines),
                                       !custom.isEmpty,
                                       custom != device.name {
                                        Text(device.name)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text("Paired \(device.pairedAt.formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    if let lastSeen = device.lastSeen {
                                        Text("Last seen \(lastSeen.formatted(.relative(presentation: .named)))")
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                Spacer()
                                if !isActive {
                                    Button {
                                        DiagnosticLog.log("settings connect tapped", tag: "view.settings", fields: [
                                            "device": device.id
                                        ])
                                        viewModel.switchToDevice(id: device.id)
                                        Haptic.success()
                                        dismiss()
                                    } label: {
                                        Text("Connect")
                                            .font(.caption.weight(.medium))
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 4)
                                            .background(theme.accent.opacity(0.15))
                                            .foregroundStyle(theme.accent)
                                            .clipShape(Capsule())
                                    }
                                    .buttonStyle(.borderless)
                                }
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                                Circle()
                                    .fill(isActive && viewModel.connectionState == .connected ? Color.green : Color(.tertiaryLabel))
                                    .frame(width: 8, height: 8)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if !isActive {
                                Button {
                                    viewModel.switchToDevice(id: device.id)
                                    Haptic.success()
                                    dismiss()
                                } label: {
                                    Label("Switch to", systemImage: "arrow.right.arrow.left")
                                }
                                .tint(theme.accent)
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

                Button {
                    showPairingSheet = true
                } label: {
                    Label("Pair New Desktop…", systemImage: "plus")
                }
            } header: {
                Text("Paired Desktops")
            } footer: {
                Text("Tap a desktop to set a custom name and icon. Changes sync to all paired iPhones.")
            }
        }
        .navigationTitle("Desktops & Connection")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showPairingSheet) {
            PairingView()
        }
        .sheet(item: $editingDevice) { device in
            DeviceCustomizationSheet(device: device)
                .environment(viewModel)
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
}
