import SwiftUI

struct SettingsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var showPairingSheet = false
    @State private var elevenLabsKey: String = ""
    @State private var keySaved = false
    @State private var voiceTestInProgress = false
    @State private var voiceTestResult: VoiceService.TestResult?
    @State private var showVoiceTestAlert = false
    @State private var voicePromptText: String = ""
    @State private var editingDevice: PairedDevice? = nil

    var body: some View {
        NavigationStack {
            List {
                themeSection
                connectionSection
                desktopSettingsSection
                voiceSection
                diagnosticsSection
                newTabSection
                tabListSection
                agentPanelSection
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
            .sheet(item: $editingDevice) { device in
                DeviceCustomizationSheet(device: device)
                    .environment(viewModel)
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

    private var themeSection: some View {
        Section {
            Picker("Theme", selection: Binding(
                get: { theme.selectedThemeId },
                set: { newValue in
                    theme.selectedThemeId = newValue
                    DiagnosticLog.log("[SettingsView] theme picker set to: \(newValue)")
                }
            )) {
                ForEach(ThemeRegistry.themes, id: \.id) { t in
                    Text(t.displayName).tag(t.id)
                }
            }
            .onChange(of: theme.selectedThemeId) { oldVal, newVal in
                DiagnosticLog.log("[SettingsView] theme picker changed: \(oldVal) -> \(newVal)")
                DiagnosticLog.log("[SettingsView] theme.accent is now: \(theme.accent)")
            }
        } header: {
            Text("Appearance")
        } footer: {
            Text("Arc Reactor forces dark mode. Ion Default follows system settings.")
        }
    }

    private var voiceSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { viewModel.voiceService.isEnabled },
                set: {
                    viewModel.voiceService.isEnabled = $0
                    viewModel.sendVoiceConfig()
                }
            )) {
                Label("Voice Responses", systemImage: "waveform")
            }
            SecureField("ElevenLabs API Key", text: $elevenLabsKey)
                .textContentType(.password)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Button {
                if elevenLabsKey.trimmingCharacters(in: .whitespaces).isEmpty {
                    KeychainHelper.delete("com.ion.remote.elevenlabs")
                } else {
                    KeychainHelper.set(elevenLabsKey, service: "com.ion.remote.elevenlabs")
                }
                withAnimation { keySaved = true }
                Haptic.success()
                Task {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    withAnimation { keySaved = false }
                }
            } label: {
                HStack {
                    Text(keySaved ? "Key Saved ✓" : "Save Key")
                    if keySaved {
                        Spacer()
                    }
                }
                .foregroundStyle(keySaved ? .green : theme.accent)
            }
            Button {
                voiceTestInProgress = true
                Task {
                    let result = await viewModel.voiceService.testVoice()
                    voiceTestInProgress = false
                    voiceTestResult = result
                    showVoiceTestAlert = true
                    if result.isSuccess { Haptic.success() } else { Haptic.error() }
                }
            } label: {
                HStack {
                    Text("Test Voice")
                    if voiceTestInProgress {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(voiceTestInProgress)
            Picker(selection: Binding(
                get: { viewModel.voiceService.voiceMode },
                set: {
                    viewModel.voiceService.voiceMode = $0
                    viewModel.sendVoiceConfig()
                }
            )) {
                Text("Client-Only").tag(VoiceService.VoiceMode.clientOnly)
                Text("Desktop-Assisted").tag(VoiceService.VoiceMode.desktopAssisted)
            } label: {
                Label("Processing", systemImage: "cpu")
            }
            if viewModel.voiceService.voiceMode == .desktopAssisted {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Voice System Prompt")
                        .font(.subheadline.weight(.medium))
                    TextEditor(text: $voicePromptText)
                        .font(.caption)
                        .frame(minHeight: 120, maxHeight: 200)
                        .scrollContentBackground(.hidden)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    HStack {
                        Button("Save Prompt") {
                            viewModel.voiceService.voiceSystemPrompt = voicePromptText
                            viewModel.sendVoiceConfig()
                            Haptic.success()
                        }
                        .font(.subheadline)
                        Spacer()
                        Button("Reset to Default") {
                            voicePromptText = VoiceService.defaultVoicePrompt
                            viewModel.voiceService.voiceSystemPrompt = voicePromptText
                            viewModel.sendVoiceConfig()
                        }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("Voice")
        } footer: {
            if !viewModel.voiceService.isEnabled {
                Text("Voice is off.")
            } else if viewModel.voiceService.voiceMode == .desktopAssisted {
                Text("Desktop shapes LLM output for voice before iOS speaks it.")
            } else {
                Text("iOS speaks assistant responses with client-side filtering.")
            }
        }
        .onAppear {
            elevenLabsKey = KeychainHelper.get("com.ion.remote.elevenlabs") ?? ""
            voicePromptText = viewModel.voiceService.voiceSystemPrompt
        }
        .alert(
            voiceTestResult?.isSuccess == true ? "Voice Test Passed" : "Voice Test Failed",
            isPresented: $showVoiceTestAlert
        ) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(voiceTestResult?.message ?? "")
        }
    }

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

    /// "Desktop Settings" entry-point row. A single NavigationLink that
    /// pushes the per-desktop projection editor when the current pairing
    /// has a snapshot loaded. Mirrors Apple's own Settings.app pattern
    /// of a one-row section with secondary detail text and a chevron —
    /// the row is the discoverable handle to a richer detail screen
    /// rather than a soup of inline toggles at the top level.
    ///
    /// The section is hidden entirely when no pairing is active or the
    /// initial snapshot hasn't arrived yet (`desktopSettings == nil`).
    /// This keeps the Settings screen looking intentional rather than
    /// showing a placeholder row that the user can't interact with.
    @ViewBuilder
    private var desktopSettingsSection: some View {
        if viewModel.desktopSettings != nil, viewModel.connectionState == .connected {
            Section {
                NavigationLink {
                    DesktopSettingsView()
                        .environment(viewModel)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "slider.horizontal.3")
                            .font(.body)
                            .foregroundStyle(theme.accent)
                            .frame(width: 28, height: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Desktop Settings")
                                .font(.body)
                            Text(viewModel.activeDevice?.displayName ?? "Connected desktop")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } footer: {
                Text("Preferences for the currently-connected desktop. Each paired desktop keeps its own values.")
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

    private var tabListSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { viewModel.showGitInfoInTabList },
                set: { viewModel.showGitInfoInTabList = $0 }
            )) {
                Label("Show Git Info", systemImage: "arrow.triangle.branch")
            }
        } header: {
            Text("Tab List")
        } footer: {
            Text("Shows the current branch and commit counts on each tab.")
        }
    }

    private var agentPanelSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { viewModel.agentPanelFullScreenPopup },
                set: { viewModel.agentPanelFullScreenPopup = $0 }
            )) {
                Label("Full-Screen Agent Detail", systemImage: "rectangle.expand.vertical")
            }
        } header: {
            Text("Agent Panel")
        } footer: {
            Text("When enabled, tapping an agent opens a full-screen detail view instead of expanding inline.")
        }
    }

    private var modelsSection: some View {
        let models = viewModel.availableModels
        return Section("Models") {
            Picker("Conversation", selection: Binding<String>(
                get: { viewModel.preferredModel },
                set: { newValue in viewModel.setPreferredModelDefault(newValue) }
            )) {
                ForEach(models) { model in
                    Text(model.label).tag(model.id)
                }
            }
            Picker("Engine", selection: Binding<String>(
                get: { viewModel.engineDefaultModel },
                set: { newValue in viewModel.setEngineDefaultModelDefault(newValue) }
            )) {
                Text("Same as Conversation").tag("")
                ForEach(models) { model in
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
                .onMove { source, destination in
                    var reordered = sorted
                    reordered.move(fromOffsets: source, toOffset: destination)
                    let orderedIds = reordered.map(\.id)
                    viewModel.reorderTabGroups(orderedIds: orderedIds)
                }
            }
        } header: {
            Text("Tab Groups")
        } footer: {
            if viewModel.tabGroupMode == "manual" {
                Text("Drag to reorder groups. Create or delete groups from the desktop settings.")
            }
        }
    }

    private var pairedDevicesSection: some View {
        Section {
            if viewModel.pairedDevices.isEmpty {
                Text("No paired devices")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(viewModel.pairedDevices) { device in
                    let isActive = device.id == viewModel.activeDevice?.id
                    Button {
                        editingDevice = device
                        Haptic.light()
                    } label: {
                        HStack {
                            Image(systemName: device.displayIcon)
                                .font(.title3)
                                .foregroundStyle(theme.accent)
                                .frame(width: 28, height: 28)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(device.displayName)
                                        .font(.headline)
                                        .foregroundStyle(.primary)
                                    if device.customName != nil || device.customIcon != nil {
                                        Image(systemName: "pencil.circle.fill")
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                            .help("Custom name/icon set")
                                    }
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
                                // When a custom name is in use, show the original host
                                // name in small text so users can still identify the
                                // underlying machine.
                                if let custom = device.customName?.trimmingCharacters(in: .whitespacesAndNewlines),
                                   !custom.isEmpty,
                                   custom != device.name {
                                    Text(device.name)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
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
                            if !isActive {
                                Button {
                                    DiagnosticLog.log("[SettingsView] Connect tapped for device: \(device.id)")
                                    viewModel.switchToDevice(id: device.id)
                                    Haptic.success()
                                    dismiss()
                                } label: {
                                    Text("Connect")
                                        .font(.caption.weight(.medium))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 4)
                                        .background(theme.accent.opacity(0.15))
                                        .foregroundStyle(theme.accent)
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.borderless)
                            }
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                            Circle()
                                .fill(isActive && viewModel.connectionState == .connected ? Color.green : Color(.tertiaryLabel))
                                .frame(width: 8, height: 8)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        if !isActive {
                            Button {
                                viewModel.switchToDevice(id: device.id)
                                Haptic.success()
                                dismiss()
                            } label: {
                                Label("Switch to", systemImage: "arrow.right.arrow.left")
                            }
                            .tint(theme.accent)
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
        } header: {
            Text("Paired Desktops")
        } footer: {
            Text("Tap a desktop to set a custom name and icon. Changes sync to all paired iPhones.")
        }
    }

    private var appVersionString: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        let hash = info?["IonBuildHash"] as? String ?? "?"
        return "v\(version) (\(build).\(hash))"
    }

    private var aboutSection: some View {
        Section("About") {
            HStack {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "bolt.shield.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(theme.accent)
                    Text("Ion Remote")
                        .font(.headline)
                    Text(appVersionString)
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
