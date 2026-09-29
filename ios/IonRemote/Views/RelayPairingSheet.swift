import SwiftUI
import AVFoundation

// MARK: - RelayPairingSheet

/// "Pair over relay" (Ion Studio Server, child 19): enter or scan the
/// `RelayPairingPayload` JSON Ion Studio presents, then hand it to
/// `SessionViewModel.pairOverRelay`. Reached from `PairingView`.
struct RelayPairingSheet: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Environment(SessionViewModel.self) private var viewModel

    @State private var payloadText = ""
    @State private var parseError: String?
    @State private var isScanning = false
    @State private var cameraDenied = false
    @State private var isPairing = false
    /// True while a server pairing link (not a relay payload) is being paired.
    @State private var pairingFromLink = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                VStack(spacing: 8) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 40)) // design-type: SF Symbol hero glyph sized as icon geometry, not text
                        .foregroundStyle(theme.accent)
                    Text("Pair over relay")
                        .font(.title2.bold())
                    Text("Scan or paste the pairing code shown in Ion Studio.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, IonSpace.rowInset)

                Button {
                    requestCameraAndScan()
                } label: {
                    Label("Scan QR Code", systemImage: "camera.viewfinder")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.accent)
                .padding(.horizontal, 40) // design-geometry: 40pt inset beyond screenInset; off the 4pt ratio scale
                .disabled(isPairing)

                if cameraDenied {
                    Text("Camera access is denied. Enable it in Settings, or paste the code below.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, IonSpace.sectionGap)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Or paste the pairing code")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $payloadText)
                        .font(.system(.footnote, design: .monospaced)) // design-type: pasted pairing code, column-aligned monospace
                        .frame(height: 120)
                        .padding(IonSpace.hairlineGap)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.small))
                        .disabled(isPairing)
                }
                .padding(.horizontal, IonSpace.sectionGap)

                if let parseError {
                    Label(parseError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if isPairing || viewModel.pairingState.isFailed {
                    statusIndicator
                }

                Button {
                    submitPastedPayload()
                } label: {
                    Text("Pair")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
                }
                .buttonStyle(.bordered)
                .tint(theme.accent)
                .padding(.horizontal, 40) // design-geometry: 40pt inset beyond screenInset; off the 4pt ratio scale
                .disabled(payloadText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isPairing)

                Spacer()
            }
            .navigationTitle("Pair Over Relay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        // A pairing link's outcome arrives through `pairingState`, not a return value.
        .onChange(of: viewModel.pairingState.isPaired) { _, paired in
            guard paired, pairingFromLink else { return }
            pairingFromLink = false
            isPairing = false
            Haptic.success()
            dismiss()
        }
        .onChange(of: viewModel.pairingState.isFailed) { _, failed in
            guard failed, pairingFromLink else { return }
            pairingFromLink = false
            isPairing = false
        }
        .sheet(isPresented: $isScanning) {
            NavigationStack {
                QRScannerView { code in
                    isScanning = false
                    payloadText = code
                    submit(payloadText: code)
                }
                .ignoresSafeArea()
                .navigationTitle("Scan Pairing Code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { isScanning = false }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch viewModel.pairingState {
        case .connecting, .exchangingKeys, .configuringRelay:
            HStack(spacing: 8) {
                ProgressView()
                Text(pairingStatusText)
                    .foregroundStyle(.secondary)
            }
        case .failed(let error):
            Label(error.localizedDescription, systemImage: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.caption)
        default:
            EmptyView()
        }
    }

    private var pairingStatusText: String {
        switch viewModel.pairingState {
        case .connecting: return "Signing in…"
        case .exchangingKeys: return "Setting up encryption…"
        case .configuringRelay: return "Connecting to relay…"
        default: return "Pairing…"
        }
    }

    // MARK: - Camera permission

    private func requestCameraAndScan() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraDenied = false
            isScanning = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    DiagnosticLog.log("relay pairing: camera permission requested", tag: "pairing.relay.scan", fields: [
                        "granted": String(granted)
                    ])
                    self.cameraDenied = !granted
                    self.isScanning = granted
                }
            }
        case .denied, .restricted:
            DiagnosticLog.log("relay pairing: camera access denied", tag: "pairing.relay.scan", level: .warn)
            cameraDenied = true
        @unknown default:
            cameraDenied = true
        }
    }

    // MARK: - Submit

    private func submitPastedPayload() {
        submit(payloadText: payloadText)
    }

    private func submit(payloadText: String) {
        parseError = nil
        if StudioPairingLink.looksLikeLink(payloadText) {
            // A server's pairing link, not a relay pairing payload. The view
            // model reports its progress and failure through `pairingState`.
            DiagnosticLog.log("relay pairing: input is a studio pairing link", tag: "pairing.relay")
            isPairing = true
            pairingFromLink = true
            viewModel.pairWithStudioLink(payloadText)
            // A link that does not parse fails at once. If the state was
            // already a failure, no change is observed, so settle it here.
            if viewModel.pairingState.isFailed {
                isPairing = false
                pairingFromLink = false
            }
            return
        }
        guard let data = payloadText.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8) else {
            parseError = "Empty pairing code"
            return
        }
        let payload: RelayPairingPayload
        do {
            payload = try JSONDecoder().decode(RelayPairingPayload.self, from: data)
        } catch {
            DiagnosticLog.log("relay pairing: payload decode failed", tag: "pairing.relay", level: .warn, fields: [
                "error": error.localizedDescription
            ])
            parseError = "That doesn't look like a valid pairing code."
            return
        }
        guard !payload.isExpired else {
            parseError = "This pairing code has expired. Generate a new one."
            return
        }

        isPairing = true
        Task {
            let ok = await viewModel.pairOverRelay(payload: payload)
            await MainActor.run {
                isPairing = false
                if ok {
                    Haptic.success()
                    dismiss()
                }
            }
        }
    }
}
