import SwiftUI

/// The Fleet group at the root of Settings: the Fleet screen, which holds
/// every paired server; which one this phone chats on; and adding another.
struct SettingsServersSection: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    @State private var showPairing = false

    var body: some View {
        Section {
            NavigationLink {
                FleetView()
            } label: {
                SettingsCategoryLabel(title: "Fleet", symbol: "server.rack", tint: theme.categoryTileConnection, detail: Self.detail(viewModel.pairedDevices.count))
            }
            if viewModel.pairedDevices.count >= 2 {
                ChatOnPicker()
            }
            Button {
                DiagnosticLog.log("settings add server tapped", tag: "view.settings", fields: ["servers": String(viewModel.pairedDevices.count)])
                showPairing = true
            } label: {
                Label("Add server", systemImage: "plus")
            }
            // One row carries this, so it attaches once rather than once per row of the section.
            .sheet(isPresented: $showPairing) {
                PairingView()
            }
        } header: {
            Text("Fleet")
        } footer: {
            if viewModel.pairedDevices.count >= 2 {
                Text("Fleet shows every server, its settings, and the accounts signed in on it. Chat on picks the one your conversations run on.")
            }
        }
    }

    static func detail(_ servers: Int) -> String {
        servers == 1 ? "1 server" : "\(servers) servers"
    }
}
