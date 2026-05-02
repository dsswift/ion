import SwiftUI

/// Known models available for selection — mirrors desktop AVAILABLE_MODELS.
private let availableModels: [(id: String, label: String)] = [
    ("claude-opus-4-6", "Opus 4.6"),
    ("claude-sonnet-4-6", "Sonnet 4.6"),
    ("claude-haiku-4-5-20251001", "Haiku 4.5"),
]

/// Single-line status footer for engine tabs showing label, team, model picker, and context.
struct EngineFooterView: View {
    let fields: StatusFields
    let onSelectModel: (String) -> Void

    /// Currently selected model override (if any); falls back to engine-reported model.
    var selectedModel: String = "claude-sonnet-4-6"

    private var displayLabel: String {
        if selectedModel.isEmpty { return availableModels[1].label }
        return availableModels.first(where: { $0.id == selectedModel })?.label ?? selectedModel
    }

    var body: some View {
        HStack(spacing: 10) {
            // Extension name + state
            HStack(spacing: 4) {
                if let name = fields.extensionName, !name.isEmpty {
                    Text(name)
                        .fontWeight(.medium)
                }
                Text("[\(fields.state)]")
                    .foregroundStyle(.secondary)
            }

            Divider()
                .frame(height: 12)

            // Team
            if let team = fields.team, !team.isEmpty {
                Text(team)
                    .foregroundStyle(.secondary)

                Divider()
                    .frame(height: 12)
            }

            // Model picker menu
            Menu {
                ForEach(availableModels, id: \.id) { model in
                    Button {
                        onSelectModel(model.id)
                    } label: {
                        HStack {
                            Text(model.label)
                            if model.id == selectedModel {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 2) {
                    Text(displayLabel)
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                        .opacity(0.6)
                }
                .foregroundStyle(.secondary)
            }

            Spacer()

            // Context usage
            HStack(spacing: 4) {
                ProgressView(value: min(fields.contextPercent / 100.0, 1.0))
                    .frame(width: 40)
                    .tint(contextColor)
                Text("\(Int(fields.contextPercent))%")
                    .foregroundStyle(contextColor)
            }

            // Cost
            if let cost = fields.totalCostUsd {
                Text(String(format: "$%.2f", cost))
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption2)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }

    private var contextColor: Color {
        if fields.contextPercent > 90 { return .red }
        if fields.contextPercent > 75 { return .orange }
        return .secondary
    }
}
