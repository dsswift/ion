import SwiftUI

/// What the Fleet screen opens to manage the hubs a server reports to.
struct FleetHubsTarget: Identifiable, Equatable {
    /// The paired device id of the server.
    let serverId: String

    var id: String { serverId }
}

/// The Fleet Hubs sheet the Fleet screen opens for one server.
struct FleetHubsSheet: View {
    let session: ServerAdminSession

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            FleetHubsContent(session: session)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }
}

/// The Fleet Hubs one server reports to: how each link stands, removing one
/// an admin added, and adding one from its address and enrollment token.
/// Shown in the Fleet screen's sheet and as a row on the server's own page.
struct FleetHubsContent: View {
    let session: ServerAdminSession

    @State private var list: FleetHubsList?
    @State private var error: String?
    @State private var address = ""
    @State private var token = ""
    @State private var manage = true
    @State private var busy = false

    var body: some View {
        List {
            if let error {
                AdminErrorRow(message: error)
            }
            hubsSection
            addSection
        }
        .navigationTitle("Fleet Hubs")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await read() }
        .task { await read() }
        .onAppear {
            DiagnosticLog.log("fleet: hubs opened", tag: "settings.fleet", fields: ["server_id": session.serverId])
        }
    }

    @ViewBuilder
    private var hubsSection: some View {
        Section {
            if let list {
                if list.hubs.isEmpty {
                    Text("\(session.serverLabel) reports to no hub.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                ForEach(list.hubs) { hub in
                    FleetHubRow(hub: hub)
                        .swipeActions(edge: .trailing) {
                            if hub.removable, session.allows(.fleetHubsRemove) {
                                Button(role: .destructive) {
                                    Task { await change { try await session.client.removeFleetHub(url: hub.url) } }
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            }
                        }
                }
            } else if error == nil {
                AdminLoadingRow(text: "Reading \(session.serverLabel)…")
            }
        } footer: {
            if list?.restricted == true {
                Text("Your organization limits which hubs \(session.serverLabel) may report to.")
            } else {
                Text("A hub is a page that shows every server reporting to it. \(session.serverLabel) dials out to each hub and sends what this Fleet screen shows.")
            }
        }
    }

    private var addSection: some View {
        Section {
            TextField("https://hub.example.org", text: $address)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            SecureField("Enrollment token", text: $token)
            Toggle("Let this hub manage the server", isOn: $manage)
            Button(busy ? "Adding…" : "Add Hub") {
                Task {
                    let added = await change {
                        try await session.client.addFleetHub(url: address.trimmingCharacters(in: .whitespaces), enrollmentToken: token.trimmingCharacters(in: .whitespaces), manage: manage, label: session.serverLabel)
                    }
                    if added {
                        address = ""
                        token = ""
                    }
                }
            }
            .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty || token.trimmingCharacters(in: .whitespaces).isEmpty)
        } header: {
            Text("Add a Hub")
        } footer: {
            Text(Self.addFooter(denial: session.denialReason(.fleetHubsAdd)))
        }
        .disabled(!session.allows(.fleetHubsAdd))
    }

    /// The line under the add form: why this phone may not add a hub, or where the token comes from.
    static func addFooter(denial: String?) -> String {
        if let denial { return "\(denial) The enrollment token is not what is missing." }
        return "The token comes from the hub's own configuration. It is used once. A hub that manages the server can refresh its usage, restart it, and update it."
    }

    private func read() async {
        do {
            list = try await session.client.fleetHubs()
            error = nil
        } catch {
            DiagnosticLog.log("fleet: hubs could not be read", tag: "settings.fleet", level: .warn, fields: ["server_id": session.serverId, "error": String(describing: error)])
            self.error = error.localizedDescription
        }
    }

    /// Runs a change and shows the list the server answers with, or why it refused. True when the server accepted it.
    @discardableResult
    private func change(_ run: () async throws -> FleetHubsList) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            list = try await run()
            error = nil
            return true
        } catch {
            DiagnosticLog.log("fleet: hub change refused", tag: "settings.fleet", level: .warn, fields: ["server_id": session.serverId, "error": String(describing: error)])
            self.error = error.localizedDescription
            return false
        }
    }
}

/// One hub: its name, its address, and how its link stands.
private struct FleetHubRow: View {
    let hub: FleetHubStatus
    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(hub.label)
                Spacer()
                Text(hub.stateWord)
                    .font(.caption)
                    .foregroundStyle(hub.state == "connected" ? theme.statusDone : hub.state == "connecting" ? theme.textSecondary : theme.statusWarning)
            }
            Text(hub.url)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(Self.caption(hub))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// "May manage this server · Set by your organization", then why a link is down.
    static func caption(_ hub: FleetHubStatus) -> String {
        var parts = [hub.manage ? "May manage this server" : "Reported to only"]
        if !hub.removable { parts.append("Set by your organization") }
        if let detail = hub.detail, !detail.isEmpty { parts.append(detail) }
        return parts.joined(separator: " · ")
    }
}
