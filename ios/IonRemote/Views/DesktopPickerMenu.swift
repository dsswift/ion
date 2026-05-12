import SwiftUI

/// Toolbar menu for switching between paired desktops.
/// Shows the active device with a green dot, other devices with status
/// indicators, and an option to pair a new desktop.
struct DesktopPickerMenu: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Binding var showPairingSheet: Bool

    var body: some View {
        Menu {
            ForEach(viewModel.pairedDevices) { device in
                let isActive = device.id == viewModel.activeDeviceId
                    || (viewModel.activeDeviceId == nil && device.id == viewModel.pairedDevices.first?.id)
                Button {
                    if !isActive {
                        viewModel.switchToDevice(id: device.id)
                        Haptic.success()
                    }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(device.name, systemImage: "desktopcomputer")
                            if isActive {
                                Text(connectionStateLabel)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            } else if let lastSeen = device.lastSeen {
                                Text("Last seen \(lastSeen.formatted(.relative(presentation: .named)))")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        Spacer()
                        if isActive {
                            Image(systemName: "checkmark")
                        }
                    }
                }
                .disabled(isActive)
            }

            Divider()

            Button {
                viewModel.reconnect()
            } label: {
                Label("Reconnect", systemImage: "arrow.clockwise")
            }

            Button {
                showPairingSheet = true
            } label: {
                Label("Pair New Desktop…", systemImage: "plus")
            }
            .tint(IonTheme.accent)
        } label: {
            HStack(spacing: 6) {
                Text(activeDeviceName)
                    .font(.headline)
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                statusDot
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
        }
        .onAppear { pollDeviceStatus() }
    }

    // MARK: - Helpers

    private var activeDeviceName: String {
        viewModel.activeDevice?.name ?? "Ion"
    }

    @ViewBuilder
    private var statusDot: some View {
        Circle()
            .fill(activeStatusColor)
            .frame(width: 8, height: 8)
            .shadow(color: activeStatusColor.opacity(0.4), radius: 3)
    }

    private var activeStatusColor: Color {
        switch viewModel.connectionState {
        case .connected: .green
        case .reconnecting, .connecting: .orange
        default: .red
        }
    }

    private var connectionStateLabel: String {
        let connection = viewModel.connectionState.label
        switch viewModel.transportState {
        case .lanPreferred:
            return "\(connection) · LAN"
        case .relayOnly:
            return "\(connection) · Relay"
        case .disconnected:
            return connection
        }
    }

    private func pollDeviceStatus() {
        viewModel.pollDeviceStatus()
    }
}
