import SwiftUI

/// One paired server: a status dot, its name, and how it is reached now or
/// when it was last seen. The server this phone chats on shows its live
/// connection. Any other server has no standing connection, so the Fleet
/// screen passes whether its last read of that server got an answer.
struct ServerListRow: View {
    let device: PairedDevice
    /// Whether the Fleet screen's newest read of this server was answered.
    /// Nil where nothing has read it (or the read is still running).
    var fleetReached: Bool?

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    private var isActive: Bool { device.id == viewModel.activeDevice?.id }
    private var isConnected: Bool { isActive && viewModel.connectionState == .connected }
    /// Green when this phone can reach the server now: its chat connection is up, or the Fleet read was answered.
    private var isReachable: Bool { isConnected || (!isActive && fleetReached == true) }

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
                .fill(isReachable ? theme.statusDone : Color(.tertiaryLabel))
                .frame(width: 8, height: 8)
                .accessibilityLabel(isReachable ? "Reachable" : "Not reachable")
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
                lastSeen: device.lastSeen,
                fleetReached: fleetReached
            ))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }

    /// "Connected · Local network", "Reconnecting", "Reachable", "Not reachable",
    /// "Last seen 5 min ago", or "Not connected".
    static func status(isActive: Bool, connection: ConnectionState, transport: TransportState, lastSeen: Date?, fleetReached: Bool? = nil, now: Date = .now) -> String {
        if isActive {
            guard connection == .connected else { return connection.label }
            switch transport {
            case .lanPreferred: return "Connected · Local network"
            case .relayOnly: return "Connected · Relay"
            case .disconnected: return "Connected"
            }
        }
        // A server this phone does not chat on has no standing connection.
        // What the Fleet screen just learned by asking it is the truth.
        if fleetReached == true { return "Reachable" }
        if fleetReached == false { return "Not reachable" }
        guard let lastSeen else { return "Not connected" }
        return "Last seen \(lastSeen.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))"
    }
}
