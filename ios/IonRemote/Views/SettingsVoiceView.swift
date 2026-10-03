import SwiftUI

/// Voice settings, in the two directions voice travels:
///
/// - **Dictation**: speaking into the composer. On-device, always available;
///   this section shows the permission state and offers the Settings shortcut
///   when it has been refused.
/// - **Spoken responses**: the phone reading assistant replies aloud through
///   ElevenLabs. The toggle, the key, a test, and the processing mode.
///
/// The two used to share one section, so a person looking for why the mic
/// button did nothing read about API keys first.
struct SettingsVoiceView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    @State private var elevenLabsKey: String = ""
    @State private var hasStoredKey = false
    @State private var keySaved = false
    @State private var voiceTestInProgress = false
    @State private var voiceTestResult: VoiceService.TestResult?
    @State private var showVoiceTestAlert = false
    @State private var voicePromptText: String = ""

    private static let keychainService = "com.ion.remote.elevenlabs"

    var body: some View {
        List {
            dictationSection
            spokenResponsesSection
            if viewModel.voiceService.isEnabled {
                processingSection
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            viewModel.speechService.refreshPermissions()
            let stored = KeychainHelper.get(Self.keychainService) ?? ""
            elevenLabsKey = stored
            hasStoredKey = !stored.isEmpty
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

    // MARK: - Dictation

    private var dictationSection: some View {
        Section {
            LabeledContent {
                Text(permissionLabel)
                    .foregroundStyle(permissionColor)
            } label: {
                Label("Microphone & Speech", systemImage: "mic")
            }
            if viewModel.speechService.permissionState == .denied {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("Open iOS Settings", systemImage: "arrow.up.forward.app")
                }
            }
        } header: {
            Text("Dictation")
        } footer: {
            Text("Tap the microphone in the composer to dictate a prompt. Speech is recognized on this phone; audio never leaves the device.")
        }
    }

    private var permissionLabel: String {
        switch viewModel.speechService.permissionState {
        case .granted: return "Allowed"
        case .denied, .restricted: return "Not allowed"
        case .notDetermined: return "Asks on first use"
        }
    }

    private var permissionColor: Color {
        switch viewModel.speechService.permissionState {
        case .granted: return theme.statusDone
        case .denied, .restricted: return theme.statusError
        case .notDetermined: return theme.textSecondary
        }
    }

    // MARK: - Spoken responses

    private var spokenResponsesSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { viewModel.voiceService.isEnabled },
                set: {
                    viewModel.voiceService.isEnabled = $0
                    viewModel.sendVoiceConfig()
                }
            )) {
                Label("Read Responses Aloud", systemImage: "speaker.wave.2")
            }
            if viewModel.voiceService.isEnabled {
                HStack(spacing: IonSpace.compactGap) {
                    SecureField(hasStoredKey ? "ElevenLabs API key (saved)" : "ElevenLabs API key", text: $elevenLabsKey)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button(keySaved ? "Saved" : "Save") { saveKey() }
                        .font(IonType.sectionLabel)
                        .foregroundStyle(keySaved ? theme.statusDone : theme.accent)
                        .disabled(keySaved)
                }
                Button {
                    runVoiceTest()
                } label: {
                    HStack {
                        Label("Test Voice", systemImage: "play.circle")
                        if voiceTestInProgress {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(voiceTestInProgress || !hasStoredKey)
            }
        } header: {
            Text("Spoken Responses")
        } footer: {
            if !viewModel.voiceService.isEnabled {
                Text("Off. Assistant responses are not read aloud.")
            } else if !hasStoredKey {
                Text("Speech is generated by ElevenLabs. Save an API key to enable playback.")
            } else {
                Text("Speech is generated by ElevenLabs with the saved key.")
            }
        }
    }

    // MARK: - Processing

    private var processingSection: some View {
        Section {
            Picker(selection: Binding(
                get: { viewModel.voiceService.voiceMode },
                set: {
                    viewModel.voiceService.voiceMode = $0
                    viewModel.sendVoiceConfig()
                }
            )) {
                Text("On this phone").tag(VoiceService.VoiceMode.clientOnly)
                Text("On the server").tag(VoiceService.VoiceMode.desktopAssisted)
            } label: {
                Label("Shape text for speech", systemImage: "cpu")
            }
            if viewModel.voiceService.voiceMode == .desktopAssisted {
                VStack(alignment: .leading, spacing: IonSpace.compactGap) {
                    Text("Voice System Prompt")
                        .font(IonType.sectionLabel)
                    TextEditor(text: $voicePromptText)
                        .font(IonType.metadata)
                        .frame(minHeight: 120, maxHeight: 200)
                        .scrollContentBackground(.hidden)
                        .background(theme.surfaceSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
                    HStack {
                        Button("Save Prompt") {
                            viewModel.voiceService.voiceSystemPrompt = voicePromptText
                            viewModel.sendVoiceConfig()
                            Haptic.success()
                        }
                        .font(IonType.meaning)
                        Spacer()
                        Button("Reset to Default") {
                            voicePromptText = VoiceService.defaultVoicePrompt
                            viewModel.voiceService.voiceSystemPrompt = voicePromptText
                            viewModel.sendVoiceConfig()
                        }
                        .font(IonType.meaning)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("Processing")
        } footer: {
            if viewModel.voiceService.voiceMode == .desktopAssisted {
                Text("The server rewrites each response for listening before the phone speaks it, using the prompt above.")
            } else {
                Text("The phone strips code and markup from each response before speaking it.")
            }
        }
    }

    // MARK: - Actions

    private func saveKey() {
        let trimmed = elevenLabsKey.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            KeychainHelper.delete(Self.keychainService)
        } else {
            KeychainHelper.set(trimmed, service: Self.keychainService)
        }
        hasStoredKey = !trimmed.isEmpty
        DiagnosticLog.log("elevenlabs key saved", tag: "view.settings", fields: [
            "present": String(hasStoredKey)
        ])
        withAnimation { keySaved = true }
        Haptic.success()
        Task {
            // Only CancellationError can surface; the saved badge is hidden either way.
            // swiftlint:disable:next silent_try_optional
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            withAnimation { keySaved = false }
        }
    }

    private func runVoiceTest() {
        voiceTestInProgress = true
        Task {
            let result = await viewModel.voiceService.testVoice()
            voiceTestInProgress = false
            voiceTestResult = result
            showVoiceTestAlert = true
            if result.isSuccess { Haptic.success() } else { Haptic.error() }
        }
    }
}
