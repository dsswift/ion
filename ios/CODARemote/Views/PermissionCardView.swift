import SwiftUI

struct PermissionCardView: View {
    let tabId: String
    let request: PermissionRequest

    var body: some View {
        switch request.toolName {
        case "AskUserQuestion":
            AskUserQuestionCardView(tabId: tabId, request: request)
        case "ExitPlanMode":
            PlanApprovalCardView(tabId: tabId, request: request)
        default:
            PermissionCardGenericView(tabId: tabId, request: request)
        }
    }
}

// MARK: - Generic Permission Card

struct PermissionCardGenericView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(request.toolName)
                .font(.headline)

            if let toolInput = request.toolInput {
                ScrollView {
                    Text(formatJSON(toolInput))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            }

            HStack(spacing: 12) {
                ForEach(request.options) { option in
                    Button {
                        triggerHaptic()
                        viewModel.respondPermission(
                            tabId: tabId,
                            questionId: request.questionId,
                            optionId: option.id
                        )
                    } label: {
                        Text(option.label)
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(buttonTint(for: option))
                }
            }
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThickMaterial)
                .shadow(color: .black.opacity(0.3), radius: 8, y: 4)
        )
    }

    // MARK: - Helpers

    private func buttonTint(for option: PermissionOption) -> Color {
        let label = option.label.lowercased()
        if label.contains("deny") || label.contains("reject") || label.contains("no") {
            return .red
        }
        return Color(hex: 0x4ECDC4)
    }

    private func triggerHaptic() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()
    }

    private func formatJSON(_ dict: [String: AnyCodable]) -> String {
        guard let data = try? JSONEncoder().encode(dict),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let str = String(data: pretty, encoding: .utf8)
        else {
            return String(describing: dict)
        }
        return str
    }
}
