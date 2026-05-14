import SwiftUI

struct SettingsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showPairingSheet = false
    var body: some View {
        NavigationStack {
            List {
                connectionSection
                diagnosticsSection
                newTabSection
                modelsSection
                tabGroupsSection
                pairedDevicesSection
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showPairingSheet) {
                PairingView()
            }
        }
    }

    private var statusLabel: String {
        guard viewModel.connectionState == .connected else {
            return viewModel.connectionState.label
        }
        switch viewModel.transportState {
        case .lanPreferred: return "Connected (LAN)"
        case .relayOnly: return "Connected (Relay)"
        case .disconnected: return "Connected"
        }
    }

    private var transportLabel: String {
        switch viewModel.transportState {
        case .lanPreferred: return "LAN (Bonjour)"
        case .relayOnly: return "Relay (WebSocket)"
        case .disconnected: return "Disconnected"
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var connectionSection: some View {
        Section("Connection") {
            HStack {
                Text("Status")
                Spacer()
                HStack(spacing: 6) {
                    Circle()
                        .fill(viewModel.connectionState.color)
                        .frame(width: 8, height: 8)
                    Text(statusLabel)
                        .foregroundStyle(.secondary)
                }
            }

            HStack {
                Text("Relay URL")
                Spacer()
                Text(viewModel.relayURL.isEmpty ? "Not configured" : viewModel.relayURL)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private var diagnosticsSection: some View {
        Section("Diagnostics") {
            HStack {
                Label("Transport", systemImage: "antenna.radiowaves.left.and.right")
                Spacer()
                Text(transportLabel)
                    .foregroundStyle(.secondary)
            }
            if let latency = viewModel.connectionQuality.latencyLabel {
                HStack {
                    Label("Latency", systemImage: "timer")
                    Spacer()
                    Text(latency)
                        .foregroundStyle(.secondary)
                }
            }
            HStack {
                Label("Buffered", systemImage: "tray.full")
                Spacer()
                Text("\(viewModel.connectionQuality.lastBuffered)")
                    .foregroundStyle(.secondary)
            }
            HStack {
                Label("Signal", systemImage: "wifi")
                Spacer()
                Text(viewModel.connectionQuality.signalLevel.label)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var newTabSection: some View {
        Section("New Tab") {
            Picker("Default Directory", selection: Binding<String?>(
                get: { viewModel.defaultBaseDirectory },
                set: { viewModel.defaultBaseDirectory = $0 }
            )) {
                Text("None (desktop default)").tag(nil as String?)
                ForEach(viewModel.recentDirectories, id: \.self) { dir in
                    Text((dir as NSString).lastPathComponent).tag(dir as String?)
                }
            }
        }
    }

    private var modelsSection: some View {
        let models: [(id: String, label: String)] = [
            ("claude-opus-4-6", "Opus 4.6"),
            ("claude-sonnet-4-6", "Sonnet 4.6"),
            ("claude-haiku-4-5-20251001", "Haiku 4.5"),
        ]
        return Section("Models") {
            Picker("Conversation", selection: Binding<String>(
                get: { viewModel.preferredModel },
                set: { newValue in viewModel.setPreferredModelDefault(newValue) }
            )) {
                ForEach(models, id: \.id) { model in
                    Text(model.label).tag(model.id)
                }
            }
            Picker("Engine", selection: Binding<String>(
                get: { viewModel.engineDefaultModel },
                set: { newValue in viewModel.setEngineDefaultModelDefault(newValue) }
            )) {
                Text("Same as Conversation").tag("")
                ForEach(models, id: \.id) { model in
                    Text(model.label).tag(model.id)
                }
            }
        }
    }

    private var tabGroupsSection: some View {
        Section {
            Picker("Grouping", selection: Binding<String>(
                get: { viewModel.tabGroupMode == "manual" ? "manual" : "auto" },
                set: { newValue in viewModel.setTabGroupMode(newValue) }
            )) {
                Text("Auto (by directory)").tag("auto")
                Text("Manual (custom groups)").tag("manual")
            }

            if viewModel.tabGroupMode == "manual" {
                let sorted = viewModel.tabGroups.sorted { $0.order < $1.order }
                ForEach(sorted) { group in
                    HStack {
                        Text(group.label)
                        Spacer()
                        if group.isDefault {
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(.yellow)
                        }
                    }
                }
            }
        } header: {
            Text("Tab Groups")
        } footer: {
            if viewModel.tabGroupMode == "manual" {
                Text("Groups are managed on the desktop app. Create or rearrange groups from the desktop settings.")
            }
        }
    }

    private var pairedDevicesSection: some View {
        Section("Paired Desktops") {
            if viewModel.pairedDevices.isEmpty {
                Text("No paired devices")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(viewModel.pairedDevices) { device in
                    let isActive = device.id == viewModel.activeDevice?.id
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Text(device.name)
                                    .font(.headline)
                                if isActive {
                                    Text("Active")
                                        .font(.caption2)
                                        .foregroundStyle(.green)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(
                                            Capsule().stroke(Color.green, lineWidth: 1)
                                        )
                                }
                            }
                            Text("Paired \(device.pairedAt.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let lastSeen = device.lastSeen {
                                Text("Last seen \(lastSeen.formatted(.relative(presentation: .named)))")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        Spacer()
                        Circle()
                            .fill(isActive && viewModel.connectionState == .connected ? Color.green : Color(.tertiaryLabel))
                            .frame(width: 8, height: 8)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        if !isActive {
                            Button {
                                viewModel.switchToDevice(id: device.id)
                                Haptic.success()
                            } label: {
                                Label("Switch to", systemImage: "arrow.right.arrow.left")
                            }
                            .tint(IonTheme.accent)
                        }
                    }
                }
                .onDelete { offsets in
                    let devices = offsets.map { viewModel.pairedDevices[$0] }
                    for device in devices {
                        viewModel.unpairDevice(device)
                    }
                }
            }

            Button {
                showPairingSheet = true
            } label: {
                Label("Pair New Desktop…", systemImage: "plus")
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
            HStack {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "bolt.shield.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(IonTheme.accent)
                    Text("Ion Remote")
                        .font(.headline)
                    Text("v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .listRowBackground(Color.clear)

            NavigationLink("Diagnostic Log") {
                DiagnosticLogView()
            }

            Button(role: .destructive) {
                dismiss()
                viewModel.resetAll()
            } label: {
                HStack {
                    Spacer()
                    Text("Unpair All Devices")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                }
            }
            .buttonStyle(.bordered)
            .tint(.red)
            .listRowBackground(Color.clear)
        }
    }
}
