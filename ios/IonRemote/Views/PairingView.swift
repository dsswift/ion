import SwiftUI

struct PairingView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var browser = BonjourBrowser()

    // Selected service from discovery
    @State private var selectedService: DiscoveredService?

    // Credentials input (shared by sheet)
    @State private var pairingCodeInput = ""
    // Whether a codeless recovery attempt is in progress or has been tried
    @State private var attemptingRecovery = false
    @State private var recoveryAttempted = false

    // Discovery pulse animation
    @State private var pulseScale: CGFloat = 1.0

    // Code field focus
    @FocusState private var codeFieldFocused: Bool

    // Clipboard paste detection
    @State private var clipboardHasCode = false

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
                    // Relay servers require pairing through an Ion desktop first.
                    // Show info about needing LAN pairing.
                    relayInfoSheet(for: service)
                case .ionDirect:
                    ionPairingSheet(for: service)
                }
            }
        }
    }

    // MARK: - Discovery

    private var discoverySection: some View {
        Group {
            if browser.discoveredHosts.isEmpty {
                VStack(spacing: 16) {
                    ZStack {
                        Circle()
                            .stroke(IonTheme.accent.opacity(0.3), lineWidth: 2)
                            .frame(width: 80, height: 80)
                            .scaleEffect(pulseScale)
                            .opacity(2 - pulseScale)
                        Circle()
                            .stroke(IonTheme.accent.opacity(0.15), lineWidth: 2)
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
                    Text("Looking for Ion instances and relay servers.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 32)
                .frame(maxHeight: .infinity)
            } else {
                List {
                    let ionInstances = browser.discoveredHosts.filter { $0.kind == .ionDirect }
                    let relays = browser.discoveredHosts.filter { $0.kind == .relay }

                    if !ionInstances.isEmpty {
                        Section("Ion Instances") {
                            ForEach(ionInstances) { service in
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
                    .font(.caption)
                    .foregroundStyle(IonTheme.accent)
                    .frame(width: 28, height: 28)
                    .background(IonTheme.accent.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.name)
                        .font(.headline)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if viewModel.pairedDevices.contains(where: { $0.name == service.name }) {
                    Text("Paired")
                        .font(.caption2)
                        .foregroundStyle(.green)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.green.opacity(0.15), in: Capsule())
                }
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
                        .foregroundStyle(IonTheme.accent)
                    Text(service.name)
                        .font(.title2.bold())
                    Text("\(service.host):\(service.port)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 16)

                VStack(spacing: 12) {
                    Text("Relay servers require pairing through an Ion desktop app first.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Text("1. Open Ion on your desktop\n2. Enable Remote Control in Settings\n3. Click \"Pair New Device\"\n4. Select the Ion instance from the Discover list")
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
        .presentationDetents([.medium, .large])
    }

    // MARK: - Ion Direct Pairing Sheet

    private func ionPairingSheet(for service: DiscoveredService) -> some View {
        NavigationStack {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 40))
                        .foregroundStyle(IonTheme.accent)
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
                        Text("Enter the 6-digit code shown in Ion")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        let isRegular = sizeClass == .regular
                        let boxWidth: CGFloat = isRegular ? 52 : 40
                        let boxHeight: CGFloat = isRegular ? 64 : 52
                        let boxFont: Font = isRegular
                            ? .system(.largeTitle, design: .monospaced)
                            : .system(.title, design: .monospaced)

                        ZStack {
                            HStack(spacing: 8) {
                                ForEach(0..<6, id: \.self) { index in
                                    let char = index < pairingCodeInput.count
                                        ? String(pairingCodeInput[pairingCodeInput.index(pairingCodeInput.startIndex, offsetBy: index)])
                                        : ""
                                    Text(char)
                                        .font(boxFont)
                                        .frame(width: boxWidth, height: boxHeight)
                                        .background(Color(.tertiarySystemFill))
                                        .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.small))
                                        .overlay(
                                            RoundedRectangle(cornerRadius: IonTheme.Radius.small)
                                                .stroke(index == pairingCodeInput.count ? IonTheme.accent : Color(.separator), lineWidth: index == pairingCodeInput.count ? 2 : 1)
                                        )
                                }
                            }
                            .allowsHitTesting(false)

                            // Full-sized transparent TextField for reliable keyboard activation on iPad
                            TextField("", text: $pairingCodeInput)
                                .keyboardType(.numberPad)
                                .focused($codeFieldFocused)
                                .foregroundColor(.clear)
                                .tint(.clear)
                                .frame(width: boxWidth * 6 + 8 * 5, height: boxHeight)
                                .onChange(of: pairingCodeInput) { _, newValue in
                                    // Limit to 6 digits
                                    let filtered = String(newValue.prefix(6).filter(\.isNumber))
                                    if filtered != newValue { pairingCodeInput = filtered }
                                }
                        }

                        if clipboardHasCode, let clip = UIPasteboard.general.string {
                            Button {
                                pairingCodeInput = String(clip.prefix(6))
                                clipboardHasCode = false
                            } label: {
                                Label("Paste \(clip.prefix(6))", systemImage: "doc.on.clipboard")
                                    .font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .tint(IonTheme.accent)
                        }
                    }
                    .onTapGesture { codeFieldFocused = true }
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
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(IonTheme.accent)
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
            .onChange(of: viewModel.pairedDevices.count) { oldCount, newCount in
                if newCount > oldCount {
                    Haptic.success()
                    selectedService = nil
                }
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
        .presentationDetents([.medium, .large])
        .onAppear {
            if let clip = UIPasteboard.general.string,
               clip.count == 6, clip.allSatisfy(\.isNumber) {
                clipboardHasCode = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if !attemptingRecovery { codeFieldFocused = true }
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
