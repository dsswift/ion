import SwiftUI

/// Pairing with an Ion Studio Server found on this network, with no desktop
/// in between.
///
/// A desktop pairs a phone with a 6-digit PIN it shows on its own screen. A
/// Studio Server has no screen: what it mints is the eight-character
/// discovery code (`ion studio pair --code`, or Settings → Environments →
/// Discovery on a desktop-hosted one), shown grouped as `XXXX-XXXX`. This
/// sheet takes that code, so the same exchange runs against the server
/// itself and the phone ends up holding its own pairing rather than
/// borrowing a desktop's.
///
/// The exchange is `POST /auth/pair` on the port the server announces, which
/// is the Studio wire's.
struct StudioServerPairingSheet: View {
    let service: DiscoveredService
    let onDone: () -> Void

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @State private var codeInput = ""
    @FocusState private var codeFieldFocused: Bool

    /// The code as the server minted it: no dash, upper case. The server
    /// accepts either form, but showing the canonical one makes a typo
    /// visible while it is still being typed.
    private var normalizedCode: String {
        DiscoveryCode.normalize(codeInput)
    }

    private var canPair: Bool {
        DiscoveryCode.isComplete(normalizedCode) && service.studioServerURL != nil && !viewModel.pairingState.isConnecting
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                header
                codeEntry
                pairButton
                Spacer()
            }
            .navigationTitle("Ion Studio Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDone() }
                }
            }
            .onAppear { codeFieldFocused = true }
            .onChange(of: viewModel.pairingState.isPaired) { _, paired in
                if paired { onDone() }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var header: some View {
        VStack(spacing: 8) {
            Image(systemName: "server.rack")
                .font(.system(size: 40)) // design-type: SF Symbol hero glyph sized as icon geometry, not text
                .foregroundStyle(theme.accent)
            Text(service.displayName)
                .font(.title2.bold())
            Text("\(service.host):\(service.port)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, IonSpace.rowInset)
    }

    private var codeEntry: some View {
        VStack(spacing: 8) {
            Text("Enter the code from the server")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Run ion studio pair --code on the server, or open Settings → Environments → Discovery on the machine hosting it.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, IonSpace.sectionGap)

            TextField("XXXX-XXXX", text: $codeInput)
                .ionType(.mono)
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .focused($codeFieldFocused)
                .padding(.vertical, IonSpace.rowInset)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: IonTheme.Radius.small))
                .padding(.horizontal, IonSpace.sectionGap)
                .onChange(of: codeInput) { _, _ in
                    let grouped = DiscoveryCode.grouped(normalizedCode)
                    if grouped != codeInput { codeInput = grouped }
                }

            if let state = viewModel.pairingState.failureMessage {
                Text(state)
                    .font(.caption)
                    .foregroundStyle(theme.statusError)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, IonSpace.sectionGap)
            }
        }
    }

    private var pairButton: some View {
        Button {
            guard let serverURL = service.studioServerURL else {
                DiagnosticLog.log("studio server announcement has no usable address", tag: "view.pairing", level: .warn, fields: ["host": service.host])
                return
            }
            DiagnosticLog.log("pairing with a studio server", tag: "view.pairing", fields: ["host": service.host, "port": String(service.port)])
            viewModel.pairWithStudioServer(serverURL: serverURL, code: normalizedCode, name: service.displayName, machineId: service.metadata["machine"])
        } label: {
            Text(viewModel.pairingState.isConnecting ? "Pairing…" : "Pair")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14) // design-geometry: matches the desktop-pairing sheet's button
        }
        .buttonStyle(.borderedProminent)
        .tint(theme.accent)
        .disabled(!canPair)
        .padding(.horizontal, 40) // design-geometry: matches the desktop-pairing sheet's button
    }
}
