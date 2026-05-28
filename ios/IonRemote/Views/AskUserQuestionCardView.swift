import SwiftUI

struct AskUserQuestionCardView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest

    @State private var freeText: String = ""
    @FocusState private var textFieldFocused: Bool
    @State private var isExpanded = true

    /// Parse engine format: { question: "...", options?: ["A","B"] }
    private var questionData: (question: String, options: [String])? {
        guard let toolInput = request.toolInput else {
            DiagnosticLog.log("ASK-CARD: toolInput is nil for questionId=\(request.questionId) toolName=\(request.toolName)")
            return nil
        }

        // Log the raw keys and types for diagnostics
        let keysSummary = toolInput.map { "\($0.key): \(type(of: $0.value.value))=\($0.value)" }.joined(separator: ", ")
        DiagnosticLog.log("ASK-CARD: toolInput keys=[\(keysSummary)]")

        guard let questionEntry = toolInput["question"] else {
            DiagnosticLog.log("ASK-CARD: no 'question' key in toolInput. Available keys=\(Array(toolInput.keys))")
            return nil
        }

        guard let question = questionEntry.value as? String else {
            DiagnosticLog.log("ASK-CARD: 'question' value is not String. Type=\(type(of: questionEntry.value)), value=\(String(describing: questionEntry.value))")
            return nil
        }

        let options: [String]
        if let arr = toolInput["options"]?.value as? [String] {
            // Direct [String] — best case.
            options = arr
        } else if let arr = toolInput["options"]?.value as? [AnyCodable] {
            // PermissionRequest.toolInput is [String: AnyCodable], so array
            // elements are also boxed as AnyCodable. Unwrap each one.
            options = arr.compactMap { $0.value as? String }
        } else if let arr = toolInput["options"]?.value as? [Any] {
            // Fallback: Foundation NSArray from JSON deserialisation.
            options = arr.compactMap { $0 as? String }
        } else {
            options = []
        }
        DiagnosticLog.log("ASK-CARD: parsed OK question=\(question.prefix(80)), options=\(options)")
        return (question, options)
    }

    var body: some View {
        if let data = questionData {
            VStack(alignment: .leading, spacing: 12) {
                // Header — tap to collapse/expand
                Button {
                    withAnimation(IonTheme.snappySpring) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "questionmark.circle.fill")
                            .foregroundStyle(IonTheme.accent)
                        Text("Question")
                            .font(.headline)
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.up")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isExpanded {
                    // Question text
                    Text(data.question)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if data.options.isEmpty {
                        // Free-text input for open-ended questions
                        HStack(spacing: 8) {
                            TextField("Type your answer…", text: $freeText)
                                .textFieldStyle(.roundedBorder)
                                .font(.subheadline)
                                .focused($textFieldFocused)
                                .onSubmit { submitFreeText() }

                            Button {
                                submitFreeText()
                            } label: {
                                Text("Send")
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 8)
                            }
                            .buttonStyle(.borderedProminent)
                            .clipShape(Capsule())
                            .tint(IonTheme.accent)
                            .disabled(freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    } else {
                        // Option buttons
                        FlowLayout(spacing: 8) {
                            ForEach(data.options, id: \.self) { option in
                                Button {
                                    Haptic.medium()
                                    viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
                                    submitAnswer(option)
                                } label: {
                                    Text(option)
                                        .font(.subheadline.weight(.medium))
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 10)
                                }
                                .buttonStyle(.borderedProminent)
                                .clipShape(Capsule())
                                .tint(IonTheme.accent)
                            }
                        }
                    }
                }
            }
            .padding()
            .cardStyle()
            .onAppear { textFieldFocused = questionData?.options.isEmpty == true }
        } else {
            // Fallback to generic card if question data can't be parsed
            PermissionCardGenericView(tabId: tabId, request: request)
        }
    }

    private func submitFreeText() {
        let trimmed = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Haptic.medium()
        viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
        submitAnswer(trimmed)
    }

    /// Route the answer through the correct prompt pathway.
    /// Engine tabs use `submitEnginePrompt` so the desktop prompt pipeline
    /// recognises the message as engine-scoped (`isEngineTab: true`);
    /// conversation tabs use `sendPrompt` as before.
    private func submitAnswer(_ text: String) {
        if viewModel.tab(for: tabId)?.isEngine == true {
            viewModel.submitEnginePrompt(tabId: tabId, text: text)
        } else {
            viewModel.sendPrompt(tabId: tabId, text: text)
        }
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
