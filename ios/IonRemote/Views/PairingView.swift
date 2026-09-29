import SwiftUI

struct PairingView: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel

    @State private var browser = BonjourBrowser()

    // Selected service from discovery
    @State private var selectedService: DiscoveredService?

    // Discovery pulse animation
    @State private var pulseScale: CGFloat = 1.0

    // "Pair over relay" (Ion Studio Server, child 19)
    @State private var showRelayPairing = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                discoverySection
                relayPairingEntry
            }
            .navigationTitle("Pair Device")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                browser.startBrowsing()
            }
            .onDisappear {
                browser.stopBrowsing()
            }
            .sheet(item: $selectedService) { service in
                StudioServerPairingSheet(service: service) { selectedService = nil }
                    .environment(viewModel)
            }
            .sheet(isPresented: $showRelayPairing) {
                RelayPairingSheet()
                    .environment(viewModel)
            }
        }
    }

    /// Entry point for the relay-pairing flow: enter or scan a
    /// `RelayPairingPayload` from Ion Studio. Distinct from
    /// `serviceRow`/Bonjour discovery above — a relay pairing code reaches a
    /// server Bonjour can't see (personal server behind NAT, or an enterprise
    /// server Bonjour access is scoped away from).
    private var relayPairingEntry: some View {
        Button {
            DiagnosticLog.log("pairing view: pair over relay tapped", tag: "view.pairing")
            showRelayPairing = true
        } label: {
            HStack {
                Image(systemName: "qrcode")
                    .font(.body)
                    .foregroundStyle(theme.accent)
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pair over relay")
                        .font(.body)
                        .foregroundStyle(.primary)
                    Text("Enter or scan a code from Ion Studio")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, IonSpace.screenInset)
            .padding(.vertical, IonSpace.rowInset)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Discovery

    private var discoverySection: some View {
        Group {
            if browser.discoveredHosts.isEmpty {
                VStack(spacing: 16) {
                    ZStack {
                        Circle()
                            .stroke(theme.accent.opacity(0.3), lineWidth: 2)
                            .frame(width: 80, height: 80)
                            .scaleEffect(pulseScale)
                            .opacity(2 - pulseScale)
                        Circle()
                            .stroke(theme.accent.opacity(0.15), lineWidth: 2)
                            .frame(width: 80, height: 80)
                            .scaleEffect(pulseScale * 0.7 + 0.3)
                            .opacity(2 - pulseScale)
                        ProgressView()
                            .scaleEffect(1.2)
                    }
                    .onAppear {
                        withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: false)) {
                            pulseScale = 1.8
                        }
                    }
                    Text("Searching your network...")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Text("Looking for Ion Studio Servers.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, IonSpace.screenInset)
                .frame(maxHeight: .infinity)
            } else {
                List {
                    Section("Ion Studio Servers") {
                        ForEach(browser.discoveredHosts) { service in
                            serviceRow(service, icon: "server.rack", subtitle: "Pair with the server's own code")
                        }
                    }
                }
            }
        }
    }

    private func serviceRow(_ service: DiscoveredService, icon: String, subtitle: String) -> some View {
        Button {
            selectedService = service
        } label: {
            HStack {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(theme.accent)
                    .frame(width: 28, height: 28)
                    .background(theme.accent.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.displayName)
                        .font(.headline)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if viewModel.pairedDevices.contains(where: { $0.name == service.name }) {
                    Text("Paired")
                        .font(.caption2)
                        .foregroundStyle(theme.statusDone)
                        .padding(.horizontal, IonSpace.compactInset)
                        .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
                        .background(theme.statusDone.opacity(0.15), in: Capsule())
                }
                Image(systemName: "chevron.right")
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Status Indicator

    @ViewBuilder
    private var statusIndicator: some View {
        switch viewModel.pairingState {
        case .idle, .discovering:
            EmptyView()
        case .connecting(let hostName):
            HStack(spacing: 8) {
                ProgressView()
                Text("Connecting to \(hostName)...")
                    .foregroundStyle(.secondary)
            }
        case .exchangingKeys:
            HStack(spacing: 8) {
                ProgressView()
                Text("Setting up encryption...")
                    .foregroundStyle(.secondary)
            }
        case .configuringRelay:
            HStack(spacing: 8) {
                ProgressView()
                Text("Configuring...")
                    .foregroundStyle(.secondary)
            }
        case .paired:
            Label("Connected", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed(let error):
            Label(error.localizedDescription, systemImage: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.caption)
        }
    }
}
