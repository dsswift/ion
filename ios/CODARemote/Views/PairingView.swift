import SwiftUI

struct PairingView: View {
    @Environment(SessionViewModel.self) private var viewModel

    @State private var browser = BonjourBrowser()

    // Selected service from discovery
    @State private var selectedService: DiscoveredService?

    // Credentials input (shared by sheet)
    @State private var pairingCodeInput = ""
    // Whether a codeless recovery attempt is in progress or has been tried
    @State private var attemptingRecovery = false
    @State private var recoveryAttempted = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                discoverySection
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
                switch service.kind {
                case .relay:
                    // Relay servers require pairing through a CODA desktop first.
                    // Show info about needing LAN pairing.
                    relayInfoSheet(for: service)
                case .codaDirect:
                    codaPairingSheet(for: service)
                }
            }
        }
    }

    // MARK: - Discovery

    private var discoverySection: some View {
        Group {
            if browser.discoveredHosts.isEmpty {
                VStack(spacing: 16) {
                    ProgressView()
                        .scaleEffect(1.2)
                    Text("Searching your network...")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Text("Looking for CODA instances and relay servers.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 32)
                .frame(maxHeight: .infinity)
            } else {
                List {
                    let codaInstances = browser.discoveredHosts.filter { $0.kind == .codaDirect }
                    let relays = browser.discoveredHosts.filter { $0.kind == .relay }

                    if !codaInstances.isEmpty {
                        Section("CODA Instances") {
                            ForEach(codaInstances) { service in
                                serviceRow(service, icon: "desktopcomputer", subtitle: "Direct LAN connection")
                            }
                        }
                    }

                    if !relays.isEmpty {
                        Section("Relay Servers") {
                            ForEach(relays) { service in
                                serviceRow(service, icon: "server.rack", subtitle: "\(service.host):\(service.port)")
                            }
                        }
                    }
                }
            }
        }
    }

    private func serviceRow(_ service: DiscoveredService, icon: String, subtitle: String) -> some View {
        Button {
            pairingCodeInput = ""
            recoveryAttempted = false
            attemptingRecovery = false
            selectedService = service
        } label: {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(Color(hex: 0x4ECDC4))
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.name)
                        .font(.headline)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Relay Info Sheet

    private func relayInfoSheet(for service: DiscoveredService) -> some View {
        NavigationStack {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 40))
                        .foregroundStyle(Color(hex: 0x4ECDC4))
                    Text(service.name)
                        .font(.title2.bold())
                    Text("\(service.host):\(service.port)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 16)

                VStack(spacing: 12) {
                    Text("Relay servers require pairing through a CODA desktop app first.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Text("1. Open CODA on your desktop\n2. Enable Remote Control in Settings\n3. Click \"Pair New Device\"\n4. Select the CODA instance from the Discover list")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 24)

                Spacer()
            }
            .navigationTitle("Relay Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { selectedService = nil }
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - CODA Direct Pairing Sheet

    private func codaPairingSheet(for service: DiscoveredService) -> some View {
        NavigationStack {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 40))
                        .foregroundStyle(Color(hex: 0x4ECDC4))
                    Text(service.name)
                        .font(.title2.bold())
                    Text("\(service.host):\(service.port)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("Direct LAN Connection")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.top, 16)

                if attemptingRecovery {
                    VStack(spacing: 12) {
                        ProgressView()
                            .scaleEffect(1.2)
                        Text("Reconnecting...")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    VStack(spacing: 8) {
                        Text("Enter the 6-digit code shown in CODA")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        TextField("000000", text: $pairingCodeInput)
                            .keyboardType(.numberPad)
                            .font(.system(.largeTitle, design: .monospaced))
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 200)
                            .textFieldStyle(.roundedBorder)
                    }
                    .padding(.horizontal)

                    Button {
                        viewModel.pairWithCode(
                            host: service.host,
                            port: service.port,
                            name: service.name,
                            code: pairingCodeInput
                        )
                    } label: {
                        Text("Pair")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(hex: 0x4ECDC4))
                    .disabled(pairingCodeInput.count != 6 || viewModel.pairingState.isConnecting)
                    .padding(.horizontal, 40)

                    statusIndicator
                }

                Spacer()
            }
            .navigationTitle("Pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        attemptingRecovery = false
                        recoveryAttempted = false
                        selectedService = nil
                    }
                }
            }
            .onChange(of: viewModel.pairedDevices.count) { _, count in
                if count > 0 { selectedService = nil }
            }
            .task {
                // Auto-attempt codeless recovery before showing code entry.
                // If the desktop recognizes this device name, pairing completes
                // without a code. Otherwise fall back to manual code entry.
                guard !recoveryAttempted else { return }
                recoveryAttempted = true
                attemptingRecovery = true
                let ok = await viewModel.recoveryPair(
                    host: service.host,
                    port: service.port,
                    name: service.name
                )
                if !ok {
                    await MainActor.run {
                        attemptingRecovery = false
                        viewModel.pairingState = .idle
                    }
                }
            }
        }
        .presentationDetents([.medium])
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
