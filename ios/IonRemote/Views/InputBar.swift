import SwiftUI

struct InputBar: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String

    @State private var promptText = ""

    private var tab: RemoteTabState? {
        viewModel.tab(for: tabId)
    }

    private var isRunning: Bool {
        tab?.status == .running
    }

    private var isConnected: Bool {
        viewModel.connectionState == .connected
    }

    private var isQueued: Bool {
        isRunning  // Will queue behind current run
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            HStack(spacing: 8) {
                TextField("Message", text: $promptText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(1...5)
                    .disabled(!isConnected)

                if isRunning {
                    Button {
                        viewModel.cancel(tabId: tabId)
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.red)
                    }
                }

                Button {
                    guard !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    viewModel.sendPrompt(tabId: tabId, text: promptText)
                    promptText = ""
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(sendButtonColor)
                }
                .disabled(promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !isConnected)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            // Queue indicator
            if isQueued && !promptText.isEmpty {
                Text("Message will be queued")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            }
        }
        .background(.ultraThinMaterial)
        .onChange(of: viewModel.pendingInputByTab[tabId]) { _, newValue in
            if let text = newValue {
                promptText = text
                viewModel.pendingInputByTab.removeValue(forKey: tabId)
            }
        }
    }

    private var sendButtonColor: Color {
        if !isConnected {
            return .gray
        }
        return isQueued ? .orange : Color(hex: 0x4ECDC4)
    }
}
