import SwiftUI

/// How this phone reaches one server now, and the verbs on that connection:
/// reconnect the one it chats on, or switch to chatting on this one.
struct ServerConnectionRows: View {
    let session: ServerAdminSession
    let device: PairedDevice?
    /// Runs while the first row is on screen.
    var onAppear: () async -> Void = {}

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    private var isActive: Bool { device != nil && device?.id == viewModel.activeDevice?.id }

    var body: some View {
        LabeledContent("Status") {
            HStack(spacing: 6) {
                Circle()
                    .fill(session.state == .disconnected ? Color(.tertiaryLabel) : theme.statusDone)
                    .frame(width: 8, height: 8)
                Text(Self.reach(session.state))
            }
        }
        .task { await onAppear() }
        if let relay = device?.relayURL, !relay.isEmpty {
            LabeledContent("Relay") {
                Text(relay).lineLimit(1).truncationMode(.middle)
            }
        }
        if isActive {
            Button("Reconnect") {
                DiagnosticLog.log("overview: reconnect requested", tag: "settings.overview", fields: ["server_id": session.serverId])
                viewModel.reconnect()
                Haptic.light()
            }
        } else if let device {
            Button("Chat on this server") {
                DiagnosticLog.log("overview: chat-on switched", tag: "settings.overview", fields: ["server_id": session.serverId])
                viewModel.switchToDevice(id: device.id)
                Haptic.success()
            }
        }
    }

    static func reach(_ state: TransportState) -> String {
        switch state {
        case .lanPreferred: return "Connected on the local network"
        case .relayOnly: return "Connected through the relay"
        case .disconnected: return "Not connected"
        }
    }
}
