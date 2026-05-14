import SwiftUI

/// Known models available for selection — mirrors desktop AVAILABLE_MODELS.
private let availableModels: [(id: String, label: String)] = [
    ("claude-opus-4-6", "Opus 4.6"),
    ("claude-sonnet-4-6", "Sonnet 4.6"),
    ("claude-haiku-4-5-20251001", "Haiku 4.5"),
]

/// Context window sizes per model (in tokens).
private let modelContextWindows: [String: Int] = [
    "claude-opus-4-6": 1_000_000,
    "claude-sonnet-4-6": 200_000,
    "claude-haiku-4-5-20251001": 200_000,
]

/// Single-line status bar for conversation tabs showing model picker and context usage.
struct ConversationStatusBar: View {
    let modelOverride: String?
    let preferredModel: String
    let contextPercent: Double?
    let contextTokens: Int?
    let isRunning: Bool
    let onSelectModel: (String) -> Void

    /// The effective model: override > preferred > default fallback.
    private var effectiveModel: String {
        let candidate = modelOverride ?? preferredModel
        return candidate.isEmpty ? "claude-sonnet-4-6" : candidate
    }

    private var displayLabel: String {
        availableModels.first(where: { $0.id == effectiveModel })?.label ?? effectiveModel
    }

    /// Resolved context percentage (0–100) from either direct percent or computed from tokens.
    private var resolvedContextPercent: Double? {
        if let cp = contextPercent {
            return cp
        }
        if let tokens = contextTokens,
           let window = modelContextWindows[effectiveModel], window > 0 {
            return Double(tokens) / Double(window) * 100.0
        }
        return nil
    }

    private var contextColor: Color {
        guard let pct = resolvedContextPercent else { return .secondary }
        if pct > 90 { return .red }
        if pct > 75 { return .orange }
        return .secondary
    }

    var body: some View {
        HStack(spacing: 10) {
            // Model picker menu
            Menu {
                ForEach(availableModels, id: \.id) { model in
                    Button {
                        onSelectModel(model.id)
                    } label: {
                        HStack {
                            Text(model.label)
                            if model.id == effectiveModel {
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
                .opacity(isRunning ? 0.5 : 1.0)
            }

            Spacer()

            // Context usage (only when data is available)
            if let pct = resolvedContextPercent {
                HStack(spacing: 4) {
                    ProgressView(value: min(pct / 100.0, 1.0))
                        .frame(width: 40)
                        .tint(contextColor)
                    Text("\(Int(pct))%")
                        .foregroundStyle(contextColor)
                }
            }
        }
        .font(.caption2)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }
}
