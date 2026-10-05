import SwiftUI

/// Your default models on a server: the conversation default and the engine
/// default. The plan and implement models are projected rows in the same
/// section.
struct DefaultModelsAdminSection: View {
    let session: ServerAdminSession

    @State private var model: DefaultModelsModel
    @State private var picking: Picking?

    private enum Picking: String, Identifiable {
        case conversation, engine
        var id: String { rawValue }
    }

    private static let followsConversation = "Same as Conversation"

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: DefaultModelsModel(client: session.client, serverId: session.serverId))
    }

    var body: some View {
        Group {
            if let preferred = model.preferredModel, model.catalog != nil {
                pickerRow("Default conversation model", value: model.label(for: preferred)) { picking = .conversation }
                    // One row carries this, so it attaches once rather than once per row of the section.
                    .sheet(item: $picking) { which in
                        switch which {
                        case .conversation:
                            ModelPickerSheet(
                                models: model.pickerModels,
                                selectedModelId: model.preferredModel ?? "",
                                preferredModelId: model.preferredModel ?? "",
                                onSelect: { id, _ in Task { await model.setPreferredModel(id) } }
                            )
                        case .engine:
                            ModelPickerSheet(
                                models: model.pickerModels,
                                selectedModelId: model.engineDefaultModel ?? "",
                                preferredModelId: model.preferredModel ?? "",
                                inheritOption: .init(label: Self.followsConversation, value: ""),
                                onSelect: { id, _ in Task { await model.setEngineDefaultModel(id) } }
                            )
                        }
                    }
                let engine = model.engineDefaultModel ?? ""
                pickerRow("Default engine model", value: engine.isEmpty ? Self.followsConversation : model.label(for: engine)) { picking = .engine }
                if let error = model.error { AdminErrorRow(message: error) }
            } else if let error = model.error {
                AdminErrorRow(message: error)
            } else {
                AdminLoadingRow(text: "Loading your default models…")
            }
        }
        .task { await model.load() }
        .reloadsWithServerPage("ai") { [model] in await model.load() }
    }

    private func pickerRow(_ title: String, value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            LabeledContent(title) {
                HStack(spacing: IonSpace.hairlineGap) {
                    Text(value).lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
