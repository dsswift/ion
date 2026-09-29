import SwiftUI

/// Discovery: whether the server announces itself on its local network, so a
/// device nearby can find it, and the one-time code that pairs with it.
/// Finding the server grants nothing; pairing still needs the code.
struct DiscoveryAdminSection: View {
    @Environment(\.appTheme) private var theme
    let session: ServerAdminSession
    @State private var model: DiscoveryAdminModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: DiscoveryAdminModel(client: session.client, serverId: session.serverId))
    }

    /// The verbs share one scope; opening stands for all of them.
    private var actionDenial: String? { session.denialReason(.environmentDiscoveryOpen) }

    var body: some View {
        statusRow
            .task { await model.load() }
            .task { await model.watch() }
            .reloadsWithServerPage("discovery") { [model] in await model.load() }
        if let status = model.status {
            switch status.mode {
            case .sealed:
                EmptyView()
            case .off:
                ForEach(DiscoveryAdminModel.windows, id: \.minutes) { window in
                    Button("Make discoverable for \(window.label)") { Task { await model.open(minutes: window.minutes) } }
                        .disabled(model.busy || actionDenial != nil)
                }
            case .window:
                codeRow(status.code, caption: "Type this code on the other device when it finds \(session.serverLabel) nearby. It pairs one device, then a new code appears here.")
                Button("Turn off now", role: .destructive) { Task { await model.close() } }
                    .disabled(model.busy || actionDenial != nil)
            case .persistent:
                if let minted = model.mintedCode {
                    codeRow(minted.code, caption: "Expires \(minted.expiresDate.formatted(.relative(presentation: .named))). It pairs one device.")
                }
                Button(model.mintedCode == nil ? "Show a code" : "Show a new code") { Task { await model.mintCode() } }
                    .disabled(model.busy || actionDenial != nil)
            }
            if let actionDenial, status.mode != .sealed {
                caption(actionDenial)
            }
            if let error = model.actionError {
                Text(error).font(.footnote).foregroundStyle(theme.statusError)
            }
        }
    }

    @ViewBuilder private var statusRow: some View {
        if let status = model.status {
            switch status.mode {
            case .sealed:
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    Label("LAN discovery is off", systemImage: "lock")
                    caption("Your organization has turned LAN discovery off. Pair other devices with Pair a phone or a pairing link instead.")
                }
            case .off:
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    LabeledContent("Discoverable", value: "Off")
                    caption("Make \(session.serverLabel) discoverable for a while so a device nearby can find it.")
                }
            case .window:
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                        LabeledContent("Discoverable", value: "On")
                        if let until = status.untilDate {
                            caption("Turns itself off in \(AccessCountdown.remaining(until: until, now: context.date)).")
                                .monospacedDigit()
                        }
                    }
                }
            case .persistent:
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    LabeledContent("Discoverable", value: "Always")
                    caption("Set in the host's server.json. Change it by redeploying.")
                }
            }
        } else if let error = model.loadError {
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Text("Discovery could not be read.")
                Text(error).font(.footnote).foregroundStyle(theme.statusError)
            }
        } else {
            HStack(spacing: IonSpace.compactGap) {
                ProgressView()
                Text("Checking…").foregroundStyle(theme.textSecondary)
            }
        }
    }

    @ViewBuilder private func codeRow(_ code: String?, caption text: String) -> some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            if let code {
                Text(code)
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .tracking(3)
                    .textSelection(.enabled)
                caption(text)
            } else {
                Text("No code yet").foregroundStyle(theme.textSecondary)
                if actionDenial != nil {
                    caption("Only a device with admin access to \(session.serverLabel) sees the code.")
                }
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(theme.textSecondary)
    }
}
