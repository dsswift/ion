import SwiftUI

struct SettingsVoiceView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    @State private var elevenLabsKey: String = ""
    @State private var keySaved = false
    @State private var voiceTestInProgress = false
    @State private var voiceTestResult: VoiceService.TestResult?
    @State private var showVoiceTestAlert = false
    @State private var voicePromptText: String = ""

    var body: some View {
        List {
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
                            .background(theme.surfaceSecondary)
                            .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
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
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
    }
}
