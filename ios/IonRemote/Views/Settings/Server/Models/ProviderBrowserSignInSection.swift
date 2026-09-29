import SwiftUI

/// A provider's browser sign-in: GitHub Copilot's device code, or Google's
/// page, whose landing address the person pastes back.
struct ProviderBrowserSignInSection: View {
    let session: ServerAdminSession
    let model: ProviderDetailModel
    let provider: ServerProviderEntry

    @Environment(\.openURL) private var openURL
    @State private var landingAddress = ""

    var body: some View {
        Section {
            if provider.isBrowserSession {
                LabeledContent("Browser sign-in", value: "Signed in")
                Button("Sign Out", role: .destructive) {
                    Task { await model.browserSignOut() }
                }
                .disabled(model.busy || !session.allows(.oauthLogout))
            } else if let code = model.deviceCode {
                SignInCodeRows(
                    code: code.userCode,
                    verificationUrl: URL(string: code.verificationUri),
                    caption: "Enter this code on GitHub. \(session.serverLabel) finishes the sign-in once you approve it."
                )
                Button("Cancel", role: .cancel) { model.abandonBrowserSignIn() }
            } else if let pending = model.browserSignIn {
                Button {
                    openURL(pending.authorizationUrl)
                } label: {
                    Label("Open Sign-in Page", systemImage: "safari")
                }
                TextField("Address the page landed on", text: $landingAddress, axis: .vertical)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                Button("Finish Sign-in") {
                    Task {
                        if await model.completeBrowserSignIn(landingAddress: landingAddress) { landingAddress = "" }
                    }
                }
                .disabled(model.busy || landingAddress.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Cancel", role: .cancel) { model.abandonBrowserSignIn() }
            } else if !provider.hasAuth {
                Button(provider.id == "github-copilot" ? "Sign in with GitHub" : "Sign in with \(provider.label)") {
                    Task { await model.startBrowserSignIn() }
                }
                .disabled(model.busy || !session.allows(startAction))
            } else {
                LabeledContent("Browser sign-in", value: "Signed in another way")
            }
        } header: {
            Text("Sign In")
        } footer: {
            if let reason = session.denialReason(startAction) {
                Text(reason)
            } else if model.browserSignIn != nil {
                Text("Sign in, then copy the whole address from the browser's address bar, even if the page shows an error, and paste it here.")
            }
        }
    }

    private var startAction: PhoneAction {
        provider.id == "github-copilot" ? .oauthDeviceCode : .oauthStart
    }
}
