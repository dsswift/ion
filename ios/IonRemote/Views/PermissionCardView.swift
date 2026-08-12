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
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest

    @State private var dragOffset: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.contentGap) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(IonType.metadata)
                .foregroundStyle(theme.statusWarning)
            Text(request.toolName)
                .font(IonType.mono)

            if let toolInput = request.toolInput {
                ScrollView {
                    Text(formatJSON(toolInput))
                        .font(IonType.mono)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            }

            HStack(spacing: 12) {
                ForEach(request.options) { option in
                    Button {
                        Haptic.medium()
                        viewModel.respondPermission(
                            tabId: tabId,
                            questionId: request.questionId,
                            optionId: option.id
                        )
                    } label: {
                        Text(option.label)
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, IonSpace.contentGap)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(buttonTint(for: option))
                }
            }
        }
        .padding(IonSpace.rowInset)
        .background(theme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.container))
        .overlay(RoundedRectangle(cornerRadius: IonRadius.container).stroke(theme.statusWarning, lineWidth: 1))
        .overlay(RoundedRectangle(cornerRadius: IonRadius.container).stroke(permissionCardBorderColor(theme: theme), lineWidth: 1))
        .offset(y: dragOffset)
        .gesture(
            DragGesture(minimumDistance: 20)
                .onChanged { value in
                    if value.translation.height > 0 {
                        dragOffset = value.translation.height
                    }
                }
                .onEnded { value in
                    if value.translation.height > 80 {
                        Haptic.medium()
                        dismissAsDeny()
                    }
                    withAnimation(IonTheme.snappySpring) { dragOffset = 0 }
                }
        )
    }

    // MARK: - Helpers

    private func buttonTint(for option: PermissionOption) -> Color {
        let label = option.label.lowercased()
        if label.contains("deny") || label.contains("reject") || label.contains("no") {
            return theme.statusError
        }
        return theme.accent
    }

    /// Finds the deny/reject/no option and responds with it, or dismisses the card.
    private func dismissAsDeny() {
        let denyOption = request.options.first { option in
            let label = option.label.lowercased()
            return label.contains("deny") || label.contains("reject") || label.contains("no")
        }
        if let denyOption {
            viewModel.respondPermission(
                tabId: tabId,
                questionId: request.questionId,
                optionId: denyOption.id
            )
        } else if let firstOption = request.options.first {
            viewModel.respondPermission(
                tabId: tabId,
                questionId: request.questionId,
                optionId: firstOption.id
            )
        }
    }

    private func formatJSON(_ dict: [String: AnyCodable]) -> String {
        do {
            let data = try JSONEncoder().encode(dict)
            let object = try JSONSerialization.jsonObject(with: data)
            let pretty = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
            guard let string = String(data: pretty, encoding: .utf8) else {
                DiagnosticLog.log("permission JSON formatting produced invalid UTF-8", tag: "view.permission", level: .warn, fields: [
                    "keys": String(dict.keys.count)
                ])
                return String(describing: dict)
            }
            return string
        } catch {
            DiagnosticLog.log("permission JSON formatting failed", tag: "view.permission", level: .warn, fields: [
                "keys": String(dict.keys.count),
                "error": String(describing: error)
            ])
            return String(describing: dict)
        }
    }
}

func permissionCardBorderColor(theme: any AppTheme) -> Color {
    theme.usesSheetOutline ? theme.borderStrong : .clear
}
