import SwiftUI

/// Paired devices: every desktop and phone the server admits, with Revoke,
/// plus Pair a phone and Pairing link. Kept current while the page is open.
struct DevicesAdminSection: View {
    @Environment(\.appTheme) private var theme
    let session: ServerAdminSession
    @State private var model: DevicesAdminModel
    @State private var sheet: AccessSheet?

    /// Rows shown in the section before the rest move behind "All devices".
    private static let inlineLimit = 5

    init(session: ServerAdminSession) {
        self.session = session
        // The phone's credential for a server is the pairing the server knows it by.
        _model = State(initialValue: DevicesAdminModel(client: session.client, serverId: session.serverId, ownClientId: session.serverId))
    }

    private var listDenial: String? { session.denialReason(.authListClients) }
    private var revokeDenial: String? { session.denialReason(.authRevokeClient) }
    private var pairDenial: String? { session.denialReason(.authCreatePairingLink) }

    var body: some View {
        if let listDenial {
            Text(listDenial)
                .font(.footnote)
                .foregroundStyle(theme.textSecondary)
        } else if !model.loaded {
            if let error = model.loadError {
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    Text("The devices could not be read.")
                    Text(error).font(.footnote).foregroundStyle(theme.statusError)
                }
                Button("Try again") { Task { await model.load() } }
                    .disabled(model.loading)
            } else {
                HStack(spacing: IonSpace.compactGap) {
                    ProgressView()
                    Text("Loading devices…").foregroundStyle(theme.textSecondary)
                }
            }
        } else if model.clients.isEmpty {
            Text("No paired devices.").foregroundStyle(theme.textSecondary)
        } else {
            ForEach(model.clients.prefix(Self.inlineLimit)) { paired in
                NavigationLink {
                    PairedClientDetailView(model: model, paired: paired, revokeDenial: revokeDenial)
                } label: {
                    PairedClientRow(paired: paired, isOwn: model.isOwn(paired))
                }
            }
            if model.clients.count > Self.inlineLimit {
                NavigationLink {
                    PairedClientListView(model: model, revokeDenial: revokeDenial)
                } label: {
                    Text("All \(model.clients.count) devices")
                }
            }
        }
        pairButtons
    }

    /// Always present, so the section's loading and live updates hang off it.
    @ViewBuilder private var pairButtons: some View {
        Button("Pair a phone", systemImage: "qrcode") { open(.pairPhone) }
            .disabled(pairDenial != nil)
            .task {
                guard listDenial == nil else { return }
                await model.load()
            }
            .task {
                guard listDenial == nil else { return }
                await model.watch()
            }
            .reloadsWithServerPage("devices") { [model, session] in
                guard session.allows(.authListClients) else { return }
                await model.load()
            }
            .sheet(item: $sheet) { which in
                switch which {
                case .pairPhone:
                    PairPhoneSheet(serverLabel: session.serverLabel, model: PairPhoneModel(client: session.client, serverId: session.serverId))
                case .pairingLink:
                    PairingLinkSheet(serverLabel: session.serverLabel, model: PairingLinkModel(client: session.client, serverId: session.serverId))
                }
            }
        Button("Pairing link", systemImage: "link") { open(.pairingLink) }
            .disabled(pairDenial != nil)
        if let pairDenial, listDenial == nil {
            Text(pairDenial)
                .font(.footnote)
                .foregroundStyle(theme.textSecondary)
        }
    }

    private func open(_ which: AccessSheet) {
        DiagnosticLog.log("devices: sheet opened", tag: "admin.access", fields: ["server_id": session.serverId, "sheet": which.rawValue])
        sheet = which
    }
}
