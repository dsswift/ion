import SwiftUI

/// Single-line status bar for conversation tabs showing model picker,
/// permission mode toggle, and context usage.
struct ConversationStatusBar: View {
    @Environment(\.appTheme) private var theme
    let modelOverride: String?
    let preferredModel: String
    let contextPercent: Double?
    let contextTokens: Int?
    let isRunning: Bool
    let permissionMode: PermissionMode?
    let availableModels: [RemoteModelEntry]
    let attachmentCount: Int
    let onSelectModel: (String) -> Void
    let onToggleMode: () -> Void
    let onTapAttachments: () -> Void

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
           let model = availableModels.first(where: { $0.id == effectiveModel }),
           model.contextWindow > 0 {
            return Double(tokens) / Double(model.contextWindow) * 100.0
        }
        return nil
    }

    private var contextColor: Color {
        guard let pct = resolvedContextPercent else { return .secondary }
        if pct >= 80 { return .red }
        if pct >= 60 { return .orange }
        return .secondary
    }

    var body: some View {
        HStack(spacing: 10) {
            // Model picker menu
            Menu {
                ForEach(availableModels) { model in
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

            // Permission mode toggle
            if let mode = permissionMode {
                Button(action: onToggleMode) {
                    HStack(spacing: 3) {
                        Image(systemName: mode == .plan ? "doc.text" : "bolt.fill")
                        Text(mode == .plan ? "Plan" : "Auto")
                            .fontWeight(.medium)
                    }
                    .foregroundStyle(mode == .plan ? theme.accent : .secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color(.tertiarySystemFill)))
                }
                .buttonStyle(.plain)
            }

            // Attachments button
            Button(action: onTapAttachments) {
                HStack(spacing: 3) {
                    Image(systemName: "paperclip")
                    if attachmentCount > 0 {
                        Text("\(attachmentCount)")
                            .fontWeight(.medium)
                    }
                }
                .foregroundStyle(attachmentCount > 0 ? theme.accent : .secondary)
            }
            .buttonStyle(.plain)

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
