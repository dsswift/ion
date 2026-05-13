import SwiftUI

struct PlanApprovalCardView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest
    @State private var showFullPlan = false
    @State private var implementOnDismiss = false

    private var planContent: String? {
        request.toolInput?["planContent"]?.value as? String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(spacing: 6) {
                Text("Plan Ready")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color.green.opacity(0.15), in: Capsule())
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
                .mask(
                    VStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                            .frame(height: 8)
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: 8)
                    }
                )
            }

            // Action buttons
            Button {
                Haptic.medium()
                implement()
            } label: {
                Text("Implement")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
        }
        .padding()
        .cardStyle()
        .fullScreenCover(isPresented: $showFullPlan, onDismiss: {
            if implementOnDismiss {
                implementOnDismiss = false
                implement()
            }
        }) {
            if let content = planContent {
                PlanFullScreenView(content: content) {
                    implementOnDismiss = true
                    showFullPlan = false
                }
            }
        }
    }

    private func implement() {
        let prompt: String
        if let content = planContent, !content.isEmpty {
            prompt = "Implement the following plan:\n\n\(content)"
        } else {
            prompt = "Implement the plan."
        }
        viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
        viewModel.implementPlan(tabId: tabId, prompt: prompt)
    }

    @ViewBuilder
    private func planTextView(_ content: String) -> some View {
        Text(MarkdownFormatter.format(content))
            .font(.caption)
            .textSelection(.enabled)
            .padding(8)
    }
}
