import SwiftUI

/// Collapsed guided-questions card at the conversation bottom — the entry
/// point to the full-screen Questions Wizard. Rendered whenever the tab has
/// an open guided workflow; uses the existing question color ("Waiting on
/// you" treatment) and never enters the permissionQueue.
struct QuestionsCardView: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let workflow: QuestionsWorkflowState
    /// Additional queued rounds beyond this one (parallel open calls).
    let queuedCount: Int

    @State private var showWizard = false

    private var subtitle: String {
        switch workflow.phase {
        case "submitting", "awaiting_next":
            return "Working…"
        case "review":
            return "Review your answers"
        default:
            let count = workflow.request.questions.count
            return "\(count) question\(count == 1 ? "" : "s") — tap to answer"
        }
    }

    var body: some View {
        Button {
            Haptic.medium()
            showWizard = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "questionmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(workflow.request.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(theme.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                }
                Spacer()
                if queuedCount > 0 {
                    Text("+\(queuedCount)")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, IonSpace.compactInset)
                        .padding(.vertical, 2) // design-geometry: tight count-badge inset below the 4pt rhythm floor
                        .background(theme.accent.opacity(0.2), in: Capsule())
                }
                Image(systemName: "chevron.up")
                    .font(.caption)
                    .foregroundStyle(theme.textSecondary)
            }
            .padding(IonSpace.contentGap)
            .background(theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: IonRadius.container))
            .overlay(
                RoundedRectangle(cornerRadius: IonRadius.container)
                    .strokeBorder(theme.accent.opacity(0.35), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .fullScreenCover(isPresented: $showWizard) {
            // `Done` closes the cover only — never cancels or answers the
            // tool; the draft and the engine's wait both survive.
            QuestionsWizardView(tabId: tabId)
        }
        .onChange(of: viewModel.questionsStore.hasActiveQuestions(tabId: tabId)) { _, stillActive in
            // A remote final action (another device confirmed) dismisses the
            // open cover.
            if !stillActive { showWizard = false }
        }
    }
}
