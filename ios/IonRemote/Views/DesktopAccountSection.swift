import SwiftUI

/// Per-pairing OIDC account controls, shown inside a desktop's detail view.
///
/// A phone can be paired with desktops that authenticate against different
/// identity tenants, so "which account am I signed in as" is a question with a
/// different answer per desktop. This section answers it for one pairing and
/// offers the two actions that change it.
///
/// Renders nothing for PSK and LAN-direct pairings, which mint no tokens.
struct DesktopAccountSection: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    let device: PairedDevice

    @State private var switching = false
    @State private var errorMessage: String?
    @State private var showError = false
    @State private var confirmSignOut = false

    /// Live record, so the row updates as soon as a token response captures an
    /// identity (the passed-in `device` is a snapshot taken when the row opened).
    private var current: PairedDevice {
        viewModel.pairedDevices.first(where: { $0.id == device.id }) ?? device
    }

    private var isMismatch: Bool {
        viewModel.relayIdentityMismatch.contains(device.id)
    }

    var body: some View {
        if current.usesOIDC {
            Section {
                if isMismatch {
                    mismatchRow
                }
                accountRow
                if let host = current.oidcIssuerHost {
                    LabeledContent("Directory", value: host)
                        .font(.subheadline)
                }
                if let signedInAt = current.relayOidcSignedInAt {
                    LabeledContent("Signed in", value: signedInAt.formatted(.relative(presentation: .named)))
                        .font(.subheadline)
                }
                switchAccountButton
                if current.oidcAccountLabel != nil {
                    signOutButton
                }
            } header: {
                Text("Enterprise Account")
            } footer: {
                Text(isMismatch
                     ? "The relay refused this account for this desktop. Sign in with the account that owns this desktop's channel."
                     : "This desktop authenticates with its own account. Other paired desktops can use different accounts.")
            }
            .alert("Couldn't Switch Account", isPresented: $showError, presenting: errorMessage) { _ in
                Button("OK", role: .cancel) { }
            } message: { message in
                Text(message)
            }
            .confirmationDialog(
                "Sign out of this desktop?",
                isPresented: $confirmSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign Out", role: .destructive) {
                    viewModel.signOutOIDC(device: current)
                    Haptic.success()
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("The saved credential for this desktop is deleted from this iPhone. The pairing itself is kept, and you'll be asked to sign in again on the next connection.")
            }
        }
    }

    // MARK: - Rows

    private var mismatchRow: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Wrong account for this desktop")
                    .font(.subheadline.weight(.semibold))
                Text("This desktop's relay channel belongs to a different account.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var accountRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.crop.circle")
                .font(.title3)
                .foregroundStyle(theme.accent)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                if let label = current.oidcAccountLabel {
                    Text(label)
                        .font(.body)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Text("Not signed in yet")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                if let name = current.relayOidcAccountName,
                   !name.isEmpty,
                   name != current.oidcAccountLabel {
                    Text(name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var switchAccountButton: some View {
        Button {
            Task { await switchAccount() }
        } label: {
            HStack {
                Label(
                    current.oidcAccountLabel == nil ? "Sign In…" : "Switch Account…",
                    systemImage: "person.crop.circle.badge.plus"
                )
                if switching {
                    Spacer()
                    ProgressView()
                }
            }
        }
        .disabled(switching)
    }

    private var signOutButton: some View {
        Button(role: .destructive) {
            confirmSignOut = true
        } label: {
            Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
        }
        .disabled(switching)
    }

    // MARK: - Actions

    private func switchAccount() async {
        switching = true
        defer { switching = false }
        let target = current
        DiagnosticLog.log("account section: switch account tapped", tag: "view.account", fields: [
            "device": String(target.id.prefix(8)),
            "was_mismatch": String(isMismatch)
        ])
        do {
            try await viewModel.switchOIDCAccount(device: target)
            Haptic.success()
        } catch OIDCTokenError.interactiveCancelled {
            // The user dismissed the account picker; not an error worth an
            // alert, and the manager has already re-armed its cooldown.
            DiagnosticLog.log("account section: switch cancelled by user", tag: "view.account", fields: [
                "device": String(target.id.prefix(8))
            ])
        } catch {
            DiagnosticLog.log("account section: switch failed", tag: "view.account", level: .error, fields: [
                "device": String(target.id.prefix(8)),
                "error": error.localizedDescription
            ])
            Haptic.error()
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}
