import SwiftUI

/// Full-screen view for reading a plan's markdown content.
/// Presented via `.fullScreenCover` from `PlanApprovalCardView`.
/// Uses the composite `MarkdownContentView` for GitHub-style block rendering.
struct PlanFullScreenView: View {
    let content: String
    var onImplement: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                MarkdownContentView(
                    blocks: MarkdownFormatter.parse(content)
                )
                .textSelection(.enabled)
                .padding()

                if let onImplement {
                    Button {
                        Haptic.medium()
                        onImplement()
                    } label: {
                        Text("Implement")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .padding(.horizontal)
                    .padding(.bottom)
                }
            }
            .navigationTitle("Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }
}
