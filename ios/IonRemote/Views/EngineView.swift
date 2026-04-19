import SwiftUI

struct EngineView: View {
    let tabId: String
    @Environment(SessionViewModel.self) private var viewModel
    @State private var promptText = ""
    @FocusState private var isInputFocused: Bool

    private var visibleAgents: [AgentStateUpdate] {
        (viewModel.engineAgentStates[tabId] ?? []).filter(\.isVisible)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Working message header
            if let working = viewModel.engineWorkingMessages[tabId], !working.isEmpty {
                HStack {
                    ProgressView()
                        .scaleEffect(0.7)
                    Text(working)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.ultraThinMaterial)
            }

            // Pinned prompt header
            if let prompt = viewModel.enginePinnedPrompt[tabId], !prompt.isEmpty {
                HStack {
                    Text("> ")
                        .foregroundStyle(.orange)
                        .fontWeight(.semibold)
                    Text(prompt)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(.caption.monospaced())
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.ultraThinMaterial)
            }

            // Conversation area (flex space)
            Spacer()

            // Agent bars pinned to bottom (scrollable, max ~132pt = 6 rows)
            if !visibleAgents.isEmpty {
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(visibleAgents) { agent in
                            AgentBarRow(agent: agent)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                }
                .frame(maxHeight: 132)
            }

            Divider()

            // Status footer
            if let fields = viewModel.engineStatusFields[tabId] {
                EngineFooterView(fields: fields)
            }

            Divider()

            // Input bar
            HStack(spacing: 8) {
                TextField("Send a prompt...", text: $promptText)
                    .textFieldStyle(.plain)
                    .focused($isInputFocused)
                    .onSubmit {
                        submitPrompt()
                    }

                Button {
                    submitPrompt()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.orange)
                }
                .disabled(promptText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .navigationTitle("Engine")
        .navigationBarTitleDisplayMode(.inline)
        // Dialog sheet
        .sheet(item: Binding(
            get: { viewModel.engineDialogs[tabId] ?? nil },
            set: { _ in }
        )) { dialog in
            EngineDialogSheet(tabId: tabId, dialog: dialog)
        }
    }

    private func submitPrompt() {
        let trimmed = promptText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        viewModel.submitEnginePrompt(tabId: tabId, text: promptText)
        promptText = ""
    }
}

// MARK: - EngineDialogSheet

struct EngineDialogSheet: View {
    let tabId: String
    let dialog: EngineDialogInfo
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    @State private var inputText = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text(dialog.title)
                    .font(.headline)

                if dialog.method == "select", let options = dialog.options {
                    ForEach(options, id: \.self) { option in
                        Button(option) {
                            viewModel.respondEngineDialog(tabId: tabId, dialogId: dialog.id, value: option)
                            dismiss()
                        }
                        .buttonStyle(.bordered)
                    }
                } else if dialog.method == "confirm" {
                    HStack(spacing: 16) {
                        Button("No") {
                            viewModel.respondEngineDialog(tabId: tabId, dialogId: dialog.id, value: "false")
                            dismiss()
                        }
                        .buttonStyle(.bordered)
                        Button("Yes") {
                            viewModel.respondEngineDialog(tabId: tabId, dialogId: dialog.id, value: "true")
                            dismiss()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.orange)
                    }
                } else if dialog.method == "input" {
                    TextField(dialog.defaultValue ?? "Enter value", text: $inputText)
                        .textFieldStyle(.roundedBorder)
                    Button("Submit") {
                        viewModel.respondEngineDialog(tabId: tabId, dialogId: dialog.id, value: inputText)
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                }

                Spacer()
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
