import SwiftUI

/// App-owned explanation before Apple presents ASWebAuthenticationSession.
/// Apple's prompt cannot name the Ion desktop or tenant; this view can.
struct OIDCAuthenticationContextView: View {
    @Environment(\.appTheme) private var theme
    let device: PairedDevice
    let record: DesktopAccessRecord
    let onContinue: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: device.displayIcon)
                .font(.system(size: 42)) // design-type: authentication context icon sized as icon geometry
                .foregroundStyle(theme.accent)
            Text(DesktopAccessPolicy.recoveryTitle(for: record))
                .font(.title2.bold())
            Text(device.displayName).font(.headline)
            Text(DesktopAccessPolicy.recoveryMessage(for: record))
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let issuer = device.oidcIssuerHost {
                Label(issuer, systemImage: "building.2")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let previous = device.relayOidcPreviousAccount {
                Text("Previous account: \(previous)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else if let account = device.oidcAccountLabel {
                Text("Account: \(account)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Button(device.oidcIssuerHost == "login.microsoftonline.com" ? "Continue to Microsoft" : "Continue to Sign In", action: onContinue)
                .buttonStyle(.borderedProminent)
            Button("Not Now", action: onNotNow)
                .buttonStyle(.bordered)
        }
        .padding(28) // design-geometry: authentication context card inset between sectionGap and screenInset
    }
}
