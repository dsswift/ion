import SwiftUI

/// The Provider Subscription Prompt: tells the person, outside Settings, that
/// the connected server's subscription lookup needs them. With several
/// subscriptions and none chosen it lists them by label and applies the one
/// tapped. With no subscription it says so and offers Look Up Again.
/// Dismissing hides it until the server enters the state again; the Settings
/// rows are unchanged.
struct ProviderSubscriptionPromptOverlay: View {
    @Environment(SessionViewModel.self) private var viewModel
    @State private var model = SubscriptionPromptModel()
    @State private var session: ServerAdminSession?

    var body: some View {
        Group {
            if let session, let attention = model.prompt(for: session.serverId) {
                ZStack {
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .ignoresSafeArea()
                        .onTapGesture { model.dismiss(serverId: session.serverId) }
                    ProviderSubscriptionPromptCard(attention: attention, session: session, model: model)
                        .padding(IonSpace.sectionGap)
                }
            }
        }
        .task(id: followedDeviceId) { await follow() }
    }

    /// The paired server to follow: the selected one, while it is connected.
    private var followedDeviceId: String? {
        viewModel.connectionState == .connected ? viewModel.activeDevice?.id : nil
    }

    private func follow() async {
        guard followedDeviceId != nil, let device = viewModel.activeDevice, let live = viewModel.adminSession(for: device) else {
            session = nil
            return
        }
        session = live
        await model.follow(serverId: live.serverId, client: live.client)
    }
}

struct ProviderSubscriptionPromptCard: View {
    let attention: SubscriptionAttention
    let session: ServerAdminSession
    let model: SubscriptionPromptModel

    private var choosing: Bool { attention.state == ProviderSubscriptionStatus.State.selectionRequired }

    var body: some View {
        let name = ProviderSubscriptionRows.providerName(attention.status)
        VStack(alignment: .leading, spacing: IonSpace.contentGap) {
            Text(Self.title(attention)).font(.headline)
            Text(Self.explanation(attention)).font(.subheadline).foregroundStyle(.secondary)
            Text("Server: \(session.serverLabel)").font(.caption).foregroundStyle(.tertiary)
            if choosing {
                ForEach(attention.status.options ?? []) { option in
                    Button {
                        Task { await model.select(serverId: session.serverId, id: option.id, client: session.client) }
                    } label: {
                        Text(option.label).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.busy || !session.allows(.providerSelectSubscription))
                    .accessibilityLabel("Use \(option.label) for \(name)")
                }
                if let reason = session.denialReason(.providerSelectSubscription) {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let note = model.note {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
            if let error = model.operationError {
                AdminErrorRow(message: error)
            }
            HStack {
                Button(choosing ? "Not Now" : "Dismiss") { model.dismiss(serverId: session.serverId) }
                    .buttonStyle(.bordered)
                Spacer()
                Button {
                    Task { await model.refresh(serverId: session.serverId, client: session.client) }
                } label: {
                    Label(model.busy ? "Looking Up…" : "Look Up Again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy || !session.allows(.providerRefreshSubscription))
            }
        }
        .padding(IonSpace.rowInset)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: IonRadius.sheet))
    }

    static func title(_ attention: SubscriptionAttention) -> String {
        let name = ProviderSubscriptionRows.providerName(attention.status)
        return attention.state == ProviderSubscriptionStatus.State.selectionRequired
            ? "Choose a \(name) subscription"
            : "No \(name) subscription"
    }

    static func explanation(_ attention: SubscriptionAttention) -> String {
        let name = ProviderSubscriptionRows.providerName(attention.status)
        return attention.state == ProviderSubscriptionStatus.State.selectionRequired
            ? "Choose the \(name) subscription this account uses. Requests to \(name) fail until one is chosen."
            : attention.status.failureText("The signed-in account has no \(name) subscription. Requests to \(name) fail until it has one. Contact your administrator for access.")
    }
}
