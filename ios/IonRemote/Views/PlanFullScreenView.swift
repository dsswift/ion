import SwiftUI

/// Full-screen view for reading a plan's markdown content.
/// Presented via `.fullScreenCover` from `PlanApprovalCardView`.
/// Uses the composite `MarkdownContentView` for GitHub-style block rendering.
///
/// `isFetching` drives a progress indicator when the full body is still
/// arriving via paged plan_content events. Content updates reactively as
/// pages assemble.
struct PlanFullScreenView: View {
    let content: String
    var isFetching: Bool = false
    var onImplement: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                if isFetching && content.isEmpty {
                    ProgressView("Loading plan…")
                        .padding()
                        .frame(maxWidth: .infinity)
                } else {
                    MarkdownContentView(
                        blocks: MarkdownFormatter.parse(content)
                    )
                    .textSelection(.enabled)
                    .padding()

                    if isFetching {
                        ProgressView()
                            .padding(.bottom, 4)
                    }
                }

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
