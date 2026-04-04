import SwiftUI

struct AskUserQuestionCardView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest

    private var questionData: (header: String, question: String, options: [[String: String]])? {
        guard let toolInput = request.toolInput,
              let questions = toolInput["questions"]?.value as? [[String: Any]],
              let first = questions.first,
              let question = first["question"] as? String,
              let options = first["options"] as? [[String: String]]
        else { return nil }
        let header = first["header"] as? String ?? "Input Required"
        return (header, question, options)
    }

    var body: some View {
        if let data = questionData {
            VStack(alignment: .leading, spacing: 12) {
                // Header
                HStack(spacing: 6) {
                    Image(systemName: "questionmark.circle.fill")
                        .foregroundStyle(Color(hex: 0x4ECDC4))
                    Text(data.header)
                        .font(.headline)
                }

                // Question text
                Text(data.question)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                // Option buttons
                FlowLayout(spacing: 8) {
                    ForEach(data.options, id: \.self) { option in
                        if let label = option["label"] {
                            Button {
                                triggerHaptic()
                                viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
                                viewModel.sendPrompt(tabId: tabId, text: label)
                            } label: {
                                Text(label)
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Color(hex: 0x4ECDC4))
                            .help(option["description"] ?? "")
                        }
                    }
                }
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.ultraThickMaterial)
                    .shadow(color: .black.opacity(0.3), radius: 8, y: 4)
            )
        } else {
            // Fallback to generic card if question data can't be parsed
            PermissionCardGenericView(tabId: tabId, request: request)
        }
    }

    private func triggerHaptic() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()
    }
}

// MARK: - FlowLayout

/// Simple horizontal flow layout that wraps to the next line.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: .unspecified
            )
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            totalHeight = y + rowHeight
        }

        return (CGSize(width: maxWidth, height: totalHeight), positions)
    }
}
