import SwiftUI

/// Settings → Models. Both defaults use the same provider-grouped picker the
/// conversation status bar opens, so grouping/search/auth behavior is one
/// implementation on iOS (the desktop likewise resolves its Settings
/// `<optgroup>` list from the same provider grouping as its status-bar picker).
struct SettingsModelsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    /// Sentinel the engine-default picker writes when the operator wants the
    /// engine to follow the conversation model. Matches the desktop's empty
    /// `engineDefaultModel`.
    private static let inheritValue = ""
    private static let inheritLabel = "Same as Conversation"

    @State private var showConversationPicker = false
    @State private var showEnginePicker = false

    var body: some View {
        let models = viewModel.availableModels
        List {
            Section("Models") {
                pickerRow(
                    title: "Conversation",
                    detail: label(for: viewModel.preferredModel, models: models),
                ) {
                    showConversationPicker = true
                }
                pickerRow(
                    title: "Engine",
                    detail: viewModel.engineDefaultModel.isEmpty
                        ? Self.inheritLabel
                        : label(for: viewModel.engineDefaultModel, models: models),
                ) {
                    showEnginePicker = true
                }
            }
        }
        .navigationTitle("Models")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showConversationPicker) {
            ModelPickerSheet(
                models: models,
                selectedModelId: viewModel.preferredModel,
                preferredModelId: viewModel.preferredModel,
                onSelect: { viewModel.setPreferredModelDefault($0) },
            )
        }
        .sheet(isPresented: $showEnginePicker) {
            ModelPickerSheet(
                models: models,
                selectedModelId: viewModel.engineDefaultModel,
                // The star still marks the global conversation default, which
                // is the value the "Same as Conversation" row resolves to.
                preferredModelId: viewModel.preferredModel,
                inheritOption: .init(label: Self.inheritLabel, value: Self.inheritValue),
                onSelect: { viewModel.setEngineDefaultModelDefault($0) },
            )
        }
    }

    private func pickerRow(title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title)
                    .foregroundStyle(.primary)
                Spacer()
                Text(detail)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Display label for a model id, falling back to the raw id for a model
    /// the current desktop no longer lists (a provider was deconfigured, or the
    /// setting predates the catalog).
    private func label(for modelId: String, models: [RemoteModelEntry]) -> String {
        models.first { $0.id == modelId }?.label ?? modelId
    }
}
