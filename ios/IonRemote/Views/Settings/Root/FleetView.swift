import SwiftUI

/// The Fleet screen: every server this iPhone is paired with on one page.
/// A strip of totals on top, then each provider's quota summed over its
/// accounts, then every provider account seen on any of them with its
/// usage limits, then the servers themselves, each opening its settings pages.
/// Swiping an account or a server opens its provider CLI sign-ins, to switch
/// the account a server is on. Swiping a server also opens its custom
/// providers, to remove one. Account emails stay hidden until the eye button
/// reveals them, on every visit, so the screen is safe to share or capture.
struct FleetView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    @State private var model = FleetModel()
    @State private var pendingRemoval: PairedDevice?
    /// The server, and provider, whose account is being switched.
    @State private var switching: FleetSwitchTarget?
    /// An account on several reachable servers, waiting for which one to switch.
    @State private var choosingServer: FleetAccountRow?
    /// The server whose custom providers are open.
    @State private var customizing: FleetCustomProvidersTarget?
    /// The server whose Fleet Hubs are open.
    @State private var hubsOf: FleetHubsTarget?
    /// Whether account emails are shown; hidden ones read as a fixed mask.
    @State private var revealEmails = false

    var body: some View {
        List {
            totalsSection
            quotaSection
            accountsSection
            serversSection
        }
        .navigationTitle("Fleet")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    revealEmails.toggle()
                    DiagnosticLog.log("fleet: account emails toggled", tag: "settings.fleet", fields: ["shown": String(revealEmails)])
                } label: {
                    Label(revealEmails ? "Hide Emails" : "Show Emails", systemImage: revealEmails ? "eye.slash" : "eye")
                }
            }
        }
        .task { await model.load(sources) }
        .refreshable { await model.load(sources, refreshUsage: true) }
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
            Text("The server keeps running and forgets this iPhone. Pair again to reach it.")
        }
        .confirmationDialog(
            choosingServer.map { "Switch \($0.title(revealEmail: revealEmails)) on which server?" } ?? "",
            isPresented: Binding(get: { choosingServer != nil }, set: { if !$0 { choosingServer = nil } }),
            titleVisibility: .visible,
            presenting: choosingServer
        ) { row in
            ForEach(Self.switchable(row, servers: model.servers)) { machine in
                Button(machine.label) {
                    switching = FleetSwitchTarget(serverId: machine.serverId, providerId: row.provider)
                }
            }
        }
        // A sign-in that finished changed what the server reports; read it again.
        .sheet(item: $switching, onDismiss: { Task { await model.load(sources, refreshUsage: true) } }) { target in
            if let device = viewModel.pairedDevices.first(where: { $0.id == target.serverId }),
               let session = viewModel.adminSession(for: device) {
                FleetSwitchAccountSheet(session: session, providerId: target.providerId)
            } else {
                Text("This server is no longer paired with this iPhone.")
                    .foregroundStyle(.secondary)
                    .padding()
            }
        }
        // A removed provider changes what the server reports; read it again.
        .sheet(item: $customizing, onDismiss: { Task { await model.load(sources) } }) { target in
            if let device = viewModel.pairedDevices.first(where: { $0.id == target.serverId }),
               let session = viewModel.adminSession(for: device) {
                FleetCustomProvidersSheet(session: session)
            } else {
                Text("This server is no longer paired with this iPhone.")
                    .foregroundStyle(.secondary)
                    .padding()
            }
        }
        // A hub added or removed changes what the server reports; read it again.
        .sheet(item: $hubsOf, onDismiss: { Task { await model.load(sources) } }) { target in
            if let device = viewModel.pairedDevices.first(where: { $0.id == target.serverId }),
               let session = viewModel.adminSession(for: device) {
                FleetHubsSheet(session: session)
            } else {
                Text("This server is no longer paired with this iPhone.")
                    .foregroundStyle(.secondary)
                    .padding()
            }
        }
    }

    /// Opens the sign-ins of the one reachable server an account is on, or asks which.
    private func startSwitch(_ row: FleetAccountRow) {
        let machines = Self.switchable(row, servers: model.servers)
        DiagnosticLog.log("fleet: switch account asked", tag: "settings.fleet", fields: [
            "provider": row.provider, "servers": String(machines.count)
        ])
        if machines.count == 1, let only = machines.first {
            switching = FleetSwitchTarget(serverId: only.serverId, providerId: row.provider)
        } else {
            choosingServer = row
        }
    }

    /// One source per paired server that still has a credential.
    private var sources: [FleetSource] {
        viewModel.pairedDevices.compactMap { device in
            guard let session = viewModel.adminSession(for: device) else { return nil }
            return FleetSource(id: device.id, label: device.displayName, client: session.client, open: { session.open() }, close: { session.close() })
        }
    }

    /// The totals as one strip of figures, so the accounts start near the top.
    private var totalsSection: some View {
        Section {
            HStack(alignment: .top, spacing: 0) {
                totalTile("\(model.totals.serversReached)/\(viewModel.pairedDevices.count)", "Servers")
                totalTile("\(model.totals.runningConversations)", "Running")
                totalTile("\(model.totals.accountsSignedIn)/\(model.totals.accounts)", "Signed in")
                totalTile("\(model.totals.accountsExpiring)", "Expiring", warn: model.totals.accountsExpiring > 0)
            }
            .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                "\(model.totals.serversReached) of \(viewModel.pairedDevices.count) servers reached, "
                    + "\(model.totals.runningConversations) running conversations, "
                    + "\(model.totals.accountsSignedIn) of \(model.totals.accounts) accounts signed in, "
                    + "\(model.totals.accountsExpiring) with quota about to expire"
            )
        }
    }

    private func totalTile(_ value: String, _ caption: String, warn: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.headline.monospacedDigit())
                .foregroundStyle(warn ? theme.statusWarning : theme.textPrimary)
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity)
    }

    /// Each provider's quota: every limit summed over its accounts, 100% per account.
    @ViewBuilder private var quotaSection: some View {
        let pools = FleetSummary.quotaPools(model.accounts).filter { !$0.limits.isEmpty }
        if !pools.isEmpty {
            Section {
                ForEach(pools) { pool in
                    FleetQuotaPoolView(pool: pool)
                }
            } header: {
                Text("Quota")
            }
        }
    }

    private var accountsSection: some View {
        Section {
            if model.accounts.isEmpty {
                Text(model.loading ? "Reading every server…" : "No provider account has been signed in on any server in the last 30 days.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(model.accounts) { row in
                FleetAccountRowView(row: row, revealEmail: revealEmails)
                    .swipeActions(edge: .trailing) {
                        if !Self.switchable(row, servers: model.servers).isEmpty {
                            Button {
                                startSwitch(row)
                            } label: {
                                Label("Switch Account", systemImage: "arrow.left.arrow.right")
                            }
                            .tint(.accentColor)
                        }
                    }
            }
        } header: {
            Text("Accounts")
        } footer: {
            Text("A server shown in gray saw the account in the last 30 days but is not signed in to it now. Pull down to read usage again. Swipe an account or a server to switch the account a server is on. Swipe a server to remove a custom provider from it. Tap the eye to show or hide account emails.")
        }
    }

    private var serversSection: some View {
        Section {
            ForEach(viewModel.pairedDevices) { device in
                NavigationLink {
                    ServerPagesView(device: device)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        ServerListRow(device: device, fleetReached: Self.reached(model.servers.first { $0.id == device.id }))
                        if let line = Self.facts(model.servers.first { $0.id == device.id }, mostRoom: FleetSummary.mostRoomServerId(model.servers) == device.id) {
                            Text(line)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                .swipeActions(edge: .leading) {
                    if Self.reached(model.servers.first { $0.id == device.id }) == true {
                        Button {
                            switching = FleetSwitchTarget(serverId: device.id, providerId: nil)
                        } label: {
                            Label("Switch Account", systemImage: "arrow.left.arrow.right")
                        }
                        .tint(.accentColor)
                        Button {
                            customizing = FleetCustomProvidersTarget(serverId: device.id)
                        } label: {
                            Label("Custom Providers", systemImage: "puzzlepiece.extension")
                        }
                        .tint(.indigo)
                        Button {
                            hubsOf = FleetHubsTarget(serverId: device.id)
                        } label: {
                            Label("Fleet Hubs", systemImage: "dot.radiowaves.left.and.right")
                        }
                        .tint(.teal)
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        pendingRemoval = device
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
            }
        } header: {
            Text("Servers")
        }
    }

    /// Whether the newest read of a server was answered; nil before any read of it ends.
    static func reached(_ server: FleetServer?) -> Bool? {
        guard let server else { return nil }
        if server.error != nil { return false }
        return server.report != nil ? true : nil
    }

    /// The servers an account is on that answered the newest read, so a
    /// sign-in can run there now.
    static func switchable(_ row: FleetAccountRow, servers: [FleetServer]) -> [FleetAccountRow.Machine] {
        row.machines.filter { machine in reached(servers.first { $0.id == machine.serverId }) == true }
    }

    /// "0.9.1 · 2 running · 3 providers · 80% room · reports to Home hub", or why the server did not
    /// answer. `mostRoom` marks the server a new conversation has the most
    /// room on; Chat on is how this phone moves there.
    static func facts(_ server: FleetServer?, mostRoom: Bool = false) -> String? {
        guard let server else { return nil }
        if let error = server.error { return error }
        guard let report = server.report else { return nil }
        var parts = [report.server.serverVersion]
        if let running = report.server.runningConversations { parts.append("\(running) running") }
        let ready = report.providers.filter(\.hasAuth).count
        parts.append(ready == 1 ? "1 provider" : "\(ready) providers")
        if let room = FleetSummary.roomPercent(report) {
            parts.append(mostRoom ? "\(Int(room.rounded()))% room, the most now" : "\(Int(room.rounded()))% room")
        }
        if let hubs = hubLine(report.hubs) { parts.append(hubs) }
        return parts.joined(separator: " · ")
    }

    /// "reports to Home hub", or "reports to 2 hubs"; a hub whose link is down is named with why. Nil for a server on no hub.
    static func hubLine(_ hubs: [FleetReport.Hub]?) -> String? {
        guard let hubs, !hubs.isEmpty else { return nil }
        if hubs.count == 1, let hub = hubs.first {
            return hub.state == "connected" ? "reports to \(hub.label)" : "hub \(hub.label): \(FleetHubStatus.word(for: hub.state).lowercased())"
        }
        let reporting = hubs.filter { $0.state == "connected" }.count
        return reporting == hubs.count ? "reports to \(hubs.count) hubs" : "reports to \(reporting) of \(hubs.count) hubs"
    }
}
