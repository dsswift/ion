import SwiftUI
import Combine

struct InputBar: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String

    @State private var promptText = ""
    @FocusState private var isFocused: Bool
    @State private var keyboardVisible = false
    @State private var slashFilter: String?
    @State private var placeholderIndex = 0

    private let placeholders = [
        "Ask a question…",
        "Describe what you need…",
        "Type / for commands…"
    ]

    private var tab: RemoteTabState? {
        viewModel.tab(for: tabId)
    }

    private var isRunning: Bool {
        tab?.status == .running || tab?.status == .connecting
    }

    private var isConnected: Bool {
        viewModel.connectionState == .connected
    }

    private var isQueued: Bool {
        isRunning  // Will queue behind current run
    }

    private var workingDirectory: String {
        tab?.workingDirectory ?? ""
    }

    private var slashCommands: [DiscoveredSlashCommand] {
        viewModel.discoveredCommands[workingDirectory] ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            if let filter = slashFilter, !slashCommands.isEmpty {
                SlashCommandMenu(
                    filter: filter,
                    commands: slashCommands,
                    onSelect: { cmd in
                        promptText = "/\(cmd.name) "
                        slashFilter = nil
                    }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if keyboardVisible {
                KeyboardUtilityBar(
                    onDismiss: { isFocused = false },
                    promptText: $promptText
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [Color(.separator).opacity(0), Color(.separator), Color(.separator).opacity(0)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(height: 0.5)

            HStack(spacing: 8) {
                TextField("", text: $promptText, prompt: Text(placeholders[placeholderIndex]).foregroundStyle(.tertiary), axis: .vertical)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                    .overlay(RoundedRectangle(cornerRadius: IonTheme.Radius.medium).stroke(Color(.separator), lineWidth: 1))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(1...5)
                    .focused($isFocused)
                    .disabled(!isConnected)
                    .onSubmit { sendMessage() }

                if isRunning {
                    Button {
                        viewModel.cancel(tabId: tabId)
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.red)
                            .shadow(color: .red.opacity(0.3), radius: 6)
                    }
                }

                Button {
                    sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title)
                        .foregroundStyle(sendButtonColor)
                }
                .disabled(promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !isConnected)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            if promptText.count > 500 {
                HStack {
                    Spacer()
                    Text("\(promptText.count)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.trailing, 16)
                }
            }

            // Queue indicator
            if isQueued && !promptText.isEmpty {
                Text("Message will be queued")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            }
        }
        .background(.regularMaterial)
        .animation(IonTheme.snappySpring, value: keyboardVisible)
        .animation(IonTheme.snappySpring, value: slashFilter)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardVisible = false
        }
        .onChange(of: viewModel.pendingInputByTab[tabId]) { _, newValue in
            if let text = newValue {
                promptText = text
                viewModel.pendingInputByTab.removeValue(forKey: tabId)
            }
        }
        .onChange(of: promptText) { _, newText in
            updateSlashFilter(newText)
        }
        .onAppear {
            fetchCommandsIfNeeded()
        }
        .onChange(of: workingDirectory) {
            fetchCommandsIfNeeded()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                withAnimation {
                    placeholderIndex = (placeholderIndex + 1) % placeholders.count
                }
            }
        }
    }

    private func sendMessage() {
        guard !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Haptic.light()
        viewModel.sendPrompt(tabId: tabId, text: promptText)
        isFocused = false
        promptText = ""
    }

    private var sendButtonColor: Color {
        if !isConnected {
            return .gray
        }
        return isQueued ? .orange : IonTheme.accent
    }

    /// Detect if the user is typing a slash command prefix.
    private func updateSlashFilter(_ text: String) {
        // Match a lone slash-prefixed token: /foo, /e2e:setup, etc.
        let pattern = #"^\/[a-zA-Z0-9_:\-]*$"#
        if text.range(of: pattern, options: .regularExpression) != nil {
            slashFilter = text
        } else {
            slashFilter = nil
        }
    }

    private func fetchCommandsIfNeeded() {
        let dir = workingDirectory
        guard !dir.isEmpty, viewModel.discoveredCommands[dir] == nil else { return }
        viewModel.discoverCommands(directory: dir)
    }
}
