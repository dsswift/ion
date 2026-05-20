import SwiftUI

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
