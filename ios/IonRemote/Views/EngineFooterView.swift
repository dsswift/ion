import SwiftUI

/// Single-line status footer for engine tabs showing label, team, model picker, mode, and context.
struct EngineFooterView: View {
    @Environment(\.appTheme) private var theme
    let fields: StatusFields
    let onSelectModel: (String) -> Void
    var availableModels: [RemoteModelEntry] = SessionViewModel.defaultModels

    /// Currently selected model override (if any); falls back to engine-reported model.
    var selectedModel: String = "claude-sonnet-4-6"

    /// Current permission mode for this engine tab (nil hides the toggle).
    var permissionMode: PermissionMode?
    /// Called when the user confirms a mode override.
    var onToggleMode: (() -> Void)?

    @State private var showModeConfirm = false

    private var displayLabel: String {
        if selectedModel.isEmpty {
            return availableModels.first(where: { $0.id == "claude-sonnet-4-6" })?.label ?? "Sonnet 4.6"
        }
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
                ForEach(availableModels) { model in
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

            // Permission mode toggle — engine tabs are extension-controlled,
            // so tapping shows a confirmation before overriding.
            if let mode = permissionMode, onToggleMode != nil {
                Divider()
                    .frame(height: 12)

                Button {
                    showModeConfirm = true
                } label: {
                    HStack(spacing: 2) {
                        Image(systemName: mode == .plan ? "doc.text" : "bolt.fill")
                        Text(mode == .plan ? "Plan" : "Auto")
                            .fontWeight(.medium)
                    }
                    .foregroundStyle(mode == .plan ? theme.accent : .secondary)
                }
                .buttonStyle(.plain)
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
        .confirmationDialog(
            "Change Mode",
            isPresented: $showModeConfirm,
            titleVisibility: .visible
        ) {
            let targetMode = permissionMode == .plan ? "Auto" : "Plan"
            Button("Switch to \(targetMode)") {
                onToggleMode?()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The extension controls this tab's planning mode. Changing it manually may interfere with the extension's workflow.")
        }
    }

    private var contextColor: Color {
        if fields.contextPercent >= 80 { return .red }
        if fields.contextPercent >= 60 { return .orange }
        return .secondary
    }
}
