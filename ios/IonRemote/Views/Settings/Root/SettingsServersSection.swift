import SwiftUI

/// The Servers group at the root of Settings: every paired server, pushing
/// its settings pages; which one this phone chats on; and adding another.
struct SettingsServersSection: View {
    @Environment(SessionViewModel.self) private var viewModel

    @State private var showPairing = false
    @State private var pendingRemoval: PairedDevice?

    var body: some View {
        Section {
            ForEach(viewModel.pairedDevices) { device in
                NavigationLink {
                    ServerPagesView(device: device)
                } label: {
                    ServerListRow(device: device)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        pendingRemoval = device
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
            }
            if viewModel.pairedDevices.count >= 2 {
                ChatOnPicker()
            }
            Button {
                showPairing = true
            } label: {
                Label("Add server", systemImage: "plus")
            }
        } header: {
            Text("Servers")
        } footer: {
            if viewModel.pairedDevices.count >= 2 {
                Text("Settings for every server are here. Chat on picks the one your conversations run on.")
            }
        }
        .sheet(isPresented: $showPairing) {
            PairingView()
        }
        .confirmationDialog(
            pendingRemoval.map { "Remove \($0.displayName) from this iPhone?" } ?? "",
            isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
            titleVisibility: .visible,
            presenting: pendingRemoval
        ) { device in
            Button("Remove", role: .destructive) {
                DiagnosticLog.log("server removed from this phone", tag: "view.settings", fields: ["device": String(device.id.prefix(8))])
                viewModel.unpairDevice(device)
                Haptic.success()
            }
        } message: { _ in
            Text("The server keeps running. Pair again to reach it from this iPhone.")
        }
    }
}
