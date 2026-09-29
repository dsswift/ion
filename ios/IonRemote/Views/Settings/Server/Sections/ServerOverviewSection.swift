import SwiftUI

/// The Overview page's rows: how this phone reaches the server, its name and
/// icon here, the server's facts, restarting or updating it, uninstalling
/// Ion from its host, and removing it from this phone.
struct ServerOverviewSection: View {
    let session: ServerAdminSession

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.settingsNavigation) private var navigation
    @State private var model: ServerOverviewModel
    @State private var customizing: PairedDevice?
    @State private var purge: ServerPurgeModel?
    @State private var confirmingRemoval = false

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: ServerOverviewModel(client: session.client))
    }

    private var device: PairedDevice? { viewModel.pairedDevice(serverId: session.serverId) }

    var body: some View {
        // A task on a row, not on this view: a modifier on a view of several
        // rows applies to each row.
        ServerConnectionRows(session: session, device: device, onAppear: { await model.load() })
        if let device {
            Button("Name and icon") { customizing = device }
                .sheet(item: $customizing) { device in
                    DeviceCustomizationSheet(device: device)
                        .environment(viewModel)
                }
        }
        facts
        ServerLifecycleRows(session: session, model: model)
        uninstallRow
        if device != nil {
            Button("Remove from this iPhone", role: .destructive) { confirmingRemoval = true }
                .confirmationDialog("Remove \(session.serverLabel) from this iPhone?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
                    Button("Remove", role: .destructive) { removeFromPhone(reason: "removed") }
                } message: {
                    Text("The server keeps running. Pair again to reach it from this iPhone.")
                }
        }
    }

    @ViewBuilder
    private var facts: some View {
        if let info = model.info {
            ServerFactsRows(info: info)
        } else if let error = model.error {
            VStack(alignment: .leading, spacing: 6) {
                Label("Could not read the server: \(error)", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                Button("Try again") { Task { await model.load() } }
                    .buttonStyle(.borderless)
            }
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text("Reading server facts…").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var uninstallRow: some View {
        Button("Uninstall Ion from the host…", role: .destructive) {
            purge = ServerPurgeModel(client: session.client)
        }
        .disabled(!session.allows(.environmentPurgeAppraise))
        .reloadsWithServerPage("overview") { [model] in await model.load() }
        .sheet(item: $purge) { purgeModel in
            NavigationStack {
                ServerPurgeView(model: purgeModel) { removeFromPhone(reason: "uninstalled") }
            }
            .environment(viewModel)
        }
        if let reason = session.denialReason(.environmentPurgeAppraise) {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// Forgets the pairing, then returns Settings to its root: every page
    /// open for this server is about a server this phone no longer has.
    private func removeFromPhone(reason: String) {
        guard let device else { return }
        DiagnosticLog.log("overview: server removed from this phone", tag: "settings.overview", fields: [
            "server_id": session.serverId, "reason": reason
        ])
        viewModel.unpairDevice(device)
        Haptic.success()
        navigation?.popToRoot()
    }
}

