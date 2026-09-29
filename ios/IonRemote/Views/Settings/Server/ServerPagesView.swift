import SwiftUI

/// One paired server's settings: its pages, in the order and with the names
/// the desktop uses (they arrive on the server's settings snapshot). Holds the
/// server's admin session open while any of its pages is on screen.
struct ServerPagesView: View {
    let device: PairedDevice

    @Environment(SessionViewModel.self) private var viewModel
    @State private var session: ServerAdminSession?

    var body: some View {
        Group {
            if let session {
                ServerPagesList(session: session)
            } else {
                ContentUnavailableView(
                    "No credential for \(device.displayName)",
                    systemImage: "key.slash",
                    description: Text("Pair this phone with the server again to manage it.")
                )
            }
        }
        .navigationTitle(device.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            let made = session ?? viewModel.adminSession(for: device)
            session = made
            made?.open()
        }
        .onDisappear { session?.close() }
    }
}

/// The page rows for one server, with its connection state on top.
struct ServerPagesList: View {
    let session: ServerAdminSession

    var body: some View {
        List {
            Section {
                ServerConnectionHeader(session: session)
            }
            if let pages = session.settings?.pages.filter({ $0.scope == .server }) {
                if pages.isEmpty {
                    Section {
                        Text("\(session.serverLabel) is running a version of Ion that does not describe its settings pages. Update it to manage it from this phone.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ForEach(pages) { page in
                            NavigationLink(page.label) {
                                ServerPageView(session: session, page: page)
                            }
                        }
                    }
                }
            } else {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Waiting for \(session.serverLabel) to send its settings…")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/// The server's name, whether this phone reaches it now, and what it may change there.
struct ServerConnectionHeader: View {
    @Environment(\.appTheme) private var theme
    let session: ServerAdminSession

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(session.state == .disconnected ? theme.statusWarning : theme.statusDone)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.serverLabel).font(.headline)
                Text(statusLine).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var statusLine: String {
        switch session.state {
        case .disconnected: return "Connecting…"
        case .relayOnly: return "Connected through the relay"
        case .lanPreferred: return "Connected on the local network"
        }
    }
}
