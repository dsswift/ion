import SwiftUI

/// A provider's delegated-CLI sign-in on the server: install guidance, the
/// sign-in with its live stage, the pasted authorization code, or the
/// signed-in account with Sign Out.
struct ProviderCliSignInSection: View {
    let session: ServerAdminSession
    let model: ProviderDetailModel
    let provider: ServerProviderEntry

    @Environment(\.openURL) private var openURL
    @State private var code = ""

    var body: some View {
        Section {
            rows
        } header: {
            Text("\(provider.cliName) CLI")
        } footer: {
            footer
        }
    }

    @ViewBuilder private var rows: some View {
        // A sign-in waiting for its pasted code outranks the cached probe.
        if case .awaitingCode(let signInUrl) = model.login {
            if let url = signInUrl.flatMap(URL.init(string:)) {
                Button {
                    openURL(url)
                } label: {
                    Label("Open Sign-in Page", systemImage: "safari")
                }
            }
            TextField("Authorization code", text: $code)
                .font(.body.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Submit Code") {
                Task {
                    if await model.submitCode(code) { code = "" }
                }
            }
            .disabled(model.busy || code.trimmingCharacters(in: .whitespaces).isEmpty)
            cancelButton
        } else if case .waiting(let userCode, let verificationUrl) = model.login {
            if let userCode {
                SignInCodeRows(
                    code: userCode,
                    verificationUrl: verificationUrl.flatMap(URL.init(string:)),
                    caption: "Enter this code on the sign-in page. \(session.serverLabel) finishes the sign-in once you approve it."
                )
            } else {
                Label("Waiting for the sign-in…", systemImage: "hourglass").foregroundStyle(.secondary)
            }
            cancelButton
        } else if let cli = provider.cli {
            if !cli.installed {
                LabeledContent("Status", value: "Not installed")
                if let install = provider.cliInstallCommand {
                    Text(install).font(.callout.monospaced()).textSelection(.enabled)
                }
            } else if cli.authenticated {
                LabeledContent("Account", value: [cli.label ?? "Signed in", cli.email].compactMap { $0 }.joined(separator: " · "))
                Button("Sign Out", role: .destructive) {
                    Task { await model.cliSignOut() }
                }
                .disabled(model.busy || !session.allows(.providerLogout))
            } else if provider.cliSignInIsHostOnly {
                LabeledContent("Status", value: "Not signed in")
            } else {
                if case .failed(let message) = model.login {
                    AdminErrorRow(message: message)
                } else {
                    LabeledContent("Status", value: "Installed, not signed in")
                }
                Button("Sign in with \(provider.cliName)") {
                    Task { await model.startCliSignIn() }
                }
                .disabled(model.busy || !session.allows(.providerLogin))
            }
        } else {
            // The engine has not probed the CLI yet; a Sign In here could not succeed.
            Label("Checking the \(provider.cliName) CLI…", systemImage: "hourglass").foregroundStyle(.secondary)
        }
    }

    private var cancelButton: some View {
        Button("Cancel Sign-in", role: .cancel) {
            Task { await model.cancelCliSignIn() }
        }
        .disabled(!session.allows(.providerLoginCancel))
    }

    @ViewBuilder private var footer: some View {
        if case .awaitingCode = model.login {
            Text("Approve the sign-in on the page, then paste the authorization code it shows.")
        } else if let cli = provider.cli, !cli.installed {
            Text(provider.cliInstallCommand == nil
                 ? "Install the \(provider.cliName) CLI on \(session.serverLabel), then refresh its models."
                 : "Install it on \(session.serverLabel) with this command, then refresh its models.")
        } else if provider.cli?.authenticated == false, provider.cliSignInIsHostOnly {
            Text("Signing in with \(provider.cliName) finishes in a browser on \(session.serverLabel) itself, so it cannot run from this phone. Sign in on the server, or use an API key.")
        } else if let reason = session.denialReason(.providerLogin) {
            Text(reason)
        }
    }
}
