import SwiftUI

/// Recovery surface for a locked pairing. Desktop-owned data is deliberately not
/// mounted here; Settings and pairing recovery remain available.
struct DesktopAccessRecoveryView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @State private var showSettings = false
    @State private var showAuthenticationContext = false
    @State private var switchError: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Spacer()
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 48)) // design-type: recovery icon sized as icon geometry
                    .foregroundStyle(theme.accent)
                Text(DesktopAccessPolicy.recoveryTitle(for: viewModel.activeDevice?.desktopAccess))
                    .font(.title2.bold())
                Text(viewModel.activeDevice?.displayName ?? "Desktop")
                    .font(.headline)
                Text(DesktopAccessPolicy.recoveryMessage(for: viewModel.activeDevice?.desktopAccess))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28) // design-geometry: recovery card inset between sectionGap and screenInset
                if let account = viewModel.activeDevice?.oidcAccountLabel {
                    Label(account, systemImage: "person.crop.circle")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let issuer = viewModel.activeDevice?.oidcIssuerHost {
                    Label(issuer, systemImage: "building.2")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                Button {
                    showAuthenticationContext = true
                } label: {
                    Label(viewModel.activeDevice?.oidcIssuerHost == "login.microsoftonline.com" ? "Continue to Microsoft" : "Continue to Sign In", systemImage: "person.crop.circle.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal, 28) // design-geometry: recovery card inset between sectionGap and screenInset
                Button("Open Settings") { showSettings = true }
                if viewModel.pairedDevices.count > 1 {
                    Menu("Switch Desktop") {
                        ForEach(viewModel.pairedDevices) { device in
                            Button(device.displayName) { viewModel.switchToDevice(id: device.id) }
                        }
                    }
                }
                Spacer()
            }
            .navigationTitle("Desktop Access")
            .alert("Couldn't Sign In", isPresented: Binding(get: { switchError != nil }, set: { if !$0 { switchError = nil } }), presenting: switchError) { _ in
                Button("OK", role: .cancel) { }
            } message: { error in
                Text(error)
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showAuthenticationContext) {
                if let device = viewModel.activeDevice {
                    OIDCAuthenticationContextView(
                        device: device,
                        record: viewModel.activeDesktopAccess,
                        onContinue: {
                            showAuthenticationContext = false
                            Task {
                                do {
                                    try await viewModel.switchOIDCAccount(device: device)
                                } catch OIDCTokenError.interactiveCancelled {
                                    // User chose not to continue in the provider sheet.
                                    DiagnosticLog.log("recovery account switch cancelled", tag: "view.desktop_access", fields: ["device": String(device.id.prefix(8))])
                                } catch {
                                    DiagnosticLog.log("recovery account switch failed", tag: "view.desktop_access", level: .error, fields: ["device": String(device.id.prefix(8)), "error": error.localizedDescription])
                                    switchError = error.localizedDescription
                                }
                            }
                        },
                        onNotNow: {
                            showAuthenticationContext = false
                            viewModel.lockDesktop(deviceId: device.id, reason: .userCancelled, source: "auth_preflight_not_now")
                        }
                    )
                }
            }
        }
    }
}
