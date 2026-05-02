import SwiftUI

struct PlanApprovalCardView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest
    @State private var showFullPlan = false

    private var planContent: String? {
        request.toolInput?["planContent"]?.value as? String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text("Plan Ready")
                    .font(.headline)
                Spacer()
                if planContent != nil {
                    Button { showFullPlan = true } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Plan content
            if let content = planContent, !content.isEmpty {
                ScrollView {
                    planTextView(content)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 300)
                .background(Color(.tertiarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            // Action buttons
            Button {
                triggerHaptic()
                implement()
            } label: {
                Text("Implement")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThickMaterial)
                .shadow(color: .black.opacity(0.3), radius: 8, y: 4)
        )
        .fullScreenCover(isPresented: $showFullPlan) {
            if let content = planContent {
                PlanFullScreenView(content: content)
            }
        }
    }

    private func implement() {
        viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
        viewModel.setPermissionMode(tabId: tabId, mode: .auto)
        let prompt: String
        if let content = planContent, !content.isEmpty {
            prompt = "Implement the following plan:\n\n\(content)"
        } else {
            prompt = "Implement the plan."
        }
        viewModel.sendPrompt(tabId: tabId, text: prompt)
    }

    @ViewBuilder
    private func planTextView(_ content: String) -> some View {
        Text(MarkdownFormatter.format(content))
            .font(.caption)
            .textSelection(.enabled)
            .padding(8)
    }

    private func triggerHaptic() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.impactOccurred()
    }
}
