import SwiftUI

/// Full-screen guided-questions wizard: renders the current workflow's form
/// (collecting), review, and waiting phases; all mutations are revisioned
/// commands to the desktop coordinator, and remote edits replace local state
/// via the synchronized QuestionsStore. `Done` closes only this presentation.
struct QuestionsWizardView: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    /// Local draft mirror so typing stays responsive between debounced
    /// patches; re-seeded whenever the store's revision advances.
    @State private var draft: [QuestionDraftAnswer] = []
    @State private var comment: String = ""
    @State private var seenRevision: Int = -1
    @State private var patchTask: Task<Void, Never>?

    private var workflow: QuestionsWorkflowState? {
        viewModel.questionsStore.currentWorkflow(tabId: tabId)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let workflow {
                    content(workflow)
                } else {
                    // Remote final action / retirement while open.
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .font(.largeTitle)
                            .foregroundStyle(theme.accent)
                        Text("No questions waiting")
                            .font(.subheadline)
                            .foregroundStyle(theme.textSecondary)
                    }
                }
            }
            .navigationTitle(workflow?.request.title ?? "Questions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    // Done closes the cover; the draft and the wait survive.
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear { seedFromStore() }
        .onChange(of: workflow?.revision) { _, _ in seedFromStore() }
    }

    // MARK: - Phase content

    @ViewBuilder
    private func content(_ workflow: QuestionsWorkflowState) -> some View {
        switch workflow.phase {
        case "submitting", "awaiting_next":
            VStack(spacing: 10) {
                ProgressView()
                Text(workflow.phase == "submitting" ? "Sending your answers…" : "Preparing more questions…")
                    .font(.subheadline)
                    .foregroundStyle(theme.textSecondary)
            }
        case "review":
            reviewList(workflow)
        default:
            form(workflow)
        }
    }

    private func form(_ workflow: QuestionsWorkflowState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let description = workflow.request.description, !description.isEmpty {
                    Text(description)
                        .font(.subheadline)
                        .foregroundStyle(theme.textSecondary)
                }
                ForEach(workflow.request.questions) { question in
                    QuestionsWizardQuestionRow(
                        viewModel: viewModel,
                        spec: question,
                        draft: binding(for: question.id)
                    )
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Anything else? (optional)")
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                    TextField("Page comment", text: $comment, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: comment) { _, _ in schedulePatch(workflow) }
                }
                actionRow(workflow, inReview: false)
            }
            .padding()
        }
    }

    private func reviewList(_ workflow: QuestionsWorkflowState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Review your answers")
                    .font(.headline)
                if !workflow.history.isEmpty {
                    Text("\(workflow.history.count) earlier page\(workflow.history.count == 1 ? "" : "s") already submitted in this round.")
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                }
                ForEach(workflow.request.questions) { question in
                    reviewRow(question: question, workflow: workflow)
                }
                if !comment.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Page comment")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(theme.textSecondary)
                        Text(comment)
                            .font(.subheadline)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(IonSpace.contentGap)
                    .background(theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: IonRadius.container))
                }
                actionRow(workflow, inReview: true)
            }
            .padding()
        }
    }

    private func reviewRow(question: QuestionSpec, workflow: QuestionsWorkflowState) -> some View {
        let answer = workflow.draft.first { $0.questionId == question.id }
        var parts = (answer?.selectedOptionIds ?? []).map { id in
            question.options?.first { $0.id == id }?.label ?? id
        }
        if let custom = answer?.customText, !custom.isEmpty { parts.append(custom) }
        if let atts = answer?.attachments, !atts.isEmpty {
            parts.append("\(atts.count) image\(atts.count == 1 ? "" : "s") attached")
        }
        let skipped = answer?.skipped == true || parts.isEmpty
        return VStack(alignment: .leading, spacing: 2) {
            Text(question.prompt)
                .font(.caption.weight(.medium))
                .foregroundStyle(theme.textSecondary)
            Text(skipped ? "Agent decides" : parts.joined(separator: ", "))
                .font(.subheadline)
                .foregroundStyle(skipped ? theme.textSecondary : theme.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(IonSpace.contentGap)
        .background(theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: IonRadius.container))
    }

    private func actionRow(_ workflow: QuestionsWorkflowState, inReview: Bool) -> some View {
        HStack(spacing: 10) {
            if inReview {
                Button("Edit") { sendAction(workflow, kind: "edit_question") }
                    .buttonStyle(.bordered)
            }
            Button("Ask me more questions") { sendAction(workflow, kind: "request_more") }
                .buttonStyle(.bordered)
            Spacer()
            if inReview {
                Button("Confirm & send") { sendAction(workflow, kind: "final_confirm") }
                    .buttonStyle(.borderedProminent)
            } else {
                Button("Review answers") { sendAction(workflow, kind: "enter_review") }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: - Draft plumbing

    private func seedFromStore() {
        guard let workflow, workflow.revision != seenRevision else { return }
        seenRevision = workflow.revision
        draft = workflow.draft
        comment = workflow.comment ?? ""
    }

    private func binding(for questionId: String) -> Binding<QuestionDraftAnswer> {
        Binding(
            get: {
                draft.first { $0.questionId == questionId }
                    ?? QuestionDraftAnswer(questionId: questionId, selectedOptionIds: [], customText: nil, skipped: nil, attachments: nil)
            },
            set: { next in
                if let index = draft.firstIndex(where: { $0.questionId == questionId }) {
                    draft[index] = next
                } else {
                    draft.append(next)
                }
                if let workflow { schedulePatch(workflow) }
            }
        )
    }

    /// Debounced, serialized patch: only one in flight; the revision CAS on
    /// the desktop makes an overlapping send safe (stale rolls back).
    private func schedulePatch(_ workflow: QuestionsWorkflowState) {
        patchTask?.cancel()
        let answers = draft
        let pageComment = comment
        patchTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            // Sleep is cancelled when a newer edit supersedes this patch —
            // benign coalescing, not an error.
            guard !Task.isCancelled else { return }
            viewModel.sendQuestionsPatch(tabId: tabId, workflow: workflow, answers: answers, comment: pageComment)
        }
    }

    private func sendAction(_ workflow: QuestionsWorkflowState, kind: String) {
        Haptic.medium()
        // ONE atomic action: cancel the pending debounce and carry the final
        // local draft inline against the CURRENT revision. The desktop
        // applies draft + transition in a single revision step — the old
        // patch-then-action chain guessed the post-patch revision and lost
        // the CAS race whenever the debounced patch was still in flight.
        patchTask?.cancel()
        viewModel.sendQuestionsAction(tabId: tabId, workflow: workflow, kind: kind, answers: draft, comment: comment)
    }
}
