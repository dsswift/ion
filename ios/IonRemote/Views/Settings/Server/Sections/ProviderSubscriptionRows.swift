import SwiftUI

/// The provider subscription under a server's enterprise sign-in: which
/// subscription's key its engine uses, a choice when the lookup offered
/// several, and Look Up Again. Shows nothing when the server configures no
/// lookup.
struct ProviderSubscriptionRows: View {
    let session: ServerAdminSession

    @State private var model: ProviderSubscriptionModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: ProviderSubscriptionModel(session: session))
    }

    var body: some View {
        Group {
            if let status = model.status, status.state != ProviderSubscriptionStatus.State.disabled {
                content(status)
            } else {
                EmptyView()
            }
        }
        .task { await model.follow() }
    }

    @ViewBuilder private func content(_ status: ProviderSubscriptionStatus) -> some View {
        let options = status.options ?? []
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            Text("\(Self.providerName(status)) subscription")
            Text(Self.describe(status)).font(.caption).foregroundStyle(.secondary)
        }
        if options.count > 1,
           status.state == ProviderSubscriptionStatus.State.applied || status.state == ProviderSubscriptionStatus.State.selectionRequired {
            ForEach(options) { option in
                Button {
                    Task { await model.select(id: option.id) }
                } label: {
                    LabeledContent(option.label) {
                        if option.id == status.selected?.id {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
                .disabled(model.busy || option.id == status.selected?.id || !session.allows(.providerSelectSubscription))
            }
        }
        if status.state != ProviderSubscriptionStatus.State.awaitingIdentity, status.state != ProviderSubscriptionStatus.State.resolving {
            Button {
                Task { await model.refresh() }
            } label: {
                Label(model.busy ? "Looking Up…" : "Look Up Again", systemImage: "arrow.clockwise")
            }
            .disabled(model.busy || !session.allows(.providerRefreshSubscription))
        }
        if let error = model.operationError ?? (status.state == ProviderSubscriptionStatus.State.none ? nil : status.error) {
            AdminErrorRow(message: error)
        }
    }

    /// The provider the key configures, as the model picker names it.
    static func providerName(_ status: ProviderSubscriptionStatus) -> String {
        [status.providerDisplayName, status.provider].compactMap { $0 }.first { !$0.isEmpty } ?? "Provider"
    }

    /// What the row says for each state. The row's title names the provider.
    static func describe(_ status: ProviderSubscriptionStatus) -> String {
        switch status.state {
        case ProviderSubscriptionStatus.State.awaitingIdentity:
            return "Sign in to look up the subscription key."
        case ProviderSubscriptionStatus.State.resolving:
            return "Looking up the subscription…"
        case ProviderSubscriptionStatus.State.applied:
            return "Using \(status.selected?.label ?? "the subscription")."
        case ProviderSubscriptionStatus.State.selectionRequired:
            return "Choose the subscription the account uses."
        case ProviderSubscriptionStatus.State.none:
            return "The account has no subscription. Contact your administrator for access."
        case ProviderSubscriptionStatus.State.failed:
            return "The subscription lookup failed. Any key entered by hand is still in use."
        default:
            return "The subscription is in a state this app does not know: \(status.state)."
        }
    }
}
