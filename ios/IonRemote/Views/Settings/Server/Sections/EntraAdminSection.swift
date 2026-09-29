import SwiftUI

/// Enterprise sign-in on a server: the organization account its engine is
/// signed in with, so shipped telemetry carries who ran it. Sign in from the
/// phone uses a code entered at the provider's page.
struct EntraAdminSection: View {
    let session: ServerAdminSession

    @State private var model: EntraAdminModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: EntraAdminModel(session: session))
    }

    var body: some View {
        stateRow
            .task(id: model.pendingCode) { await model.appear() }
            .reloadsWithServerPage("entra") { [model] in
                // A pending device code keeps its wait; a reload would drop it.
                guard model.pendingCode == nil else { return }
                await model.load()
            }
        switch model.phase {
        case .signedIn:
            Button(role: .destructive) {
                Task { await model.signOut() }
            } label: {
                Label(model.busy ? "Signing Out…" : "Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .disabled(model.busy || !session.allows(.entraSignOut))
        case .signedOut, .failed:
            Button {
                Task { await model.signIn() }
            } label: {
                Label(model.busy ? "Starting…" : "Sign In with Microsoft", systemImage: "person.badge.key")
            }
            .disabled(model.busy || !session.allows(.entraSignIn))
        case let .awaitingCode(signIn, expiresAt):
            EntraDeviceCodeView(signIn: signIn, expiresAt: expiresAt) { model.cancelCode() }
        case .loading:
            EmptyView()
        }
        if let error = model.operationError {
            AdminErrorRow(message: error)
        }
        if let reason = session.denialReason(.entraSignIn) {
            Text(reason).font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var stateRow: some View {
        switch model.phase {
        case .loading:
            AdminLoadingRow(text: "Reading the sign-in…")
        case .signedIn(let identity):
            let name = [identity.displayName, identity.username, identity.user].first { !$0.isEmpty } ?? identity.oid
            let account = identity.username.isEmpty ? identity.user : identity.username
            LabeledContent {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
            } label: {
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    Text("Signed in as \(name)")
                    if !account.isEmpty, account != name {
                        Text(account).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        case .signedOut:
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Text("Signed out")
                Text("Sign in with your organization account so telemetry from \(session.serverLabel) carries who ran it. Tokens refresh on their own.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        case .awaitingCode:
            Text("Waiting for you to finish signing in…").foregroundStyle(.secondary)
        case .failed(let message):
            AdminErrorRow(message: message)
        }
    }
}
