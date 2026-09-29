import SwiftUI

/// One paired server in the Servers group: a status dot (green only for the
/// server this phone chats on while it is connected), its name, and how it
/// is reached now or when it was last seen.
struct ServerListRow: View {
    let device: PairedDevice

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    private var isActive: Bool { device.id == viewModel.activeDevice?.id }
    private var isConnected: Bool { isActive && viewModel.connectionState == .connected }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: device.displayIcon)
                .font(.system(size: 14, weight: .semibold)) // design-type: SF Symbol row-icon glyph sized as icon geometry, not text
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(theme.categoryTileConnection, in: RoundedRectangle(cornerRadius: IonRadius.control))
            VStack(alignment: .leading, spacing: 2) {
                Text(device.displayName)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                statusLine
            }
            Spacer(minLength: 8)
            Circle()
                .fill(isConnected ? theme.statusDone : Color(.tertiaryLabel))
                .frame(width: 8, height: 8)
                .accessibilityLabel(isConnected ? "Connected" : "Not connected")
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        if viewModel.relayIdentityMismatch.contains(device.id) {
            Label("Signed in with the wrong account", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        } else {
            Text(Self.status(
                isActive: isActive,
                connection: viewModel.connectionState,
                transport: viewModel.transportState,
                lastSeen: device.lastSeen
            ))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }

    /// "Connected · Local network", "Reconnecting", "Last seen 5 min ago", or "Not connected".
    static func status(isActive: Bool, connection: ConnectionState, transport: TransportState, lastSeen: Date?, now: Date = .now) -> String {
        if isActive {
            guard connection == .connected else { return connection.label }
            switch transport {
            case .lanPreferred: return "Connected · Local network"
            case .relayOnly: return "Connected · Relay"
            case .disconnected: return "Connected"
            }
        }
        guard let lastSeen else { return "Not connected" }
        return "Last seen \(lastSeen.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))"
    }
}
