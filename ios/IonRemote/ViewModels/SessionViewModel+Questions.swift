import Foundation

// MARK: - Guided Questions (command + reconciliation behavior)
//
// The state itself lives in QuestionsStore (a stored property on
// SessionViewModel — Swift extensions cannot add stored properties). This
// extension owns the wire behavior: applying desktop_questions_state events,
// merging snapshot-carried workflows, sending revisioned patches/actions,
// and requesting authoritative refresh on reconnect/sequence loss.
extension SessionViewModel {

    /// Apply a desktop_questions_state event (authoritative replacement for
    /// the tab, revision-gated inside the store).
    @MainActor
    func handleQuestionsState(tabId: String, state: QuestionsStateSnapshot) {
        questionsStore.applyStateEvent(tabId: tabId, state: state)
        if let result = state.lastActionResult, result.accepted == false {
            // A rejected/duplicate action: the canonical state in this event
            // already replaced the optimistic local edit; log for diagnosis.
            DiagnosticLog.log("questions action rejected; canonical state applied", tag: "questions", level: .warn, fields: [
                "tab_id": String(tabId.prefix(8)),
                "action_id": result.actionId,
                "error": result.error ?? "",
            ])
        }
        DiagnosticLog.log("questions state applied", tag: "questions", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(questionsStore.openWorkflows(tabId: tabId).count),
        ])
    }

    /// Merge snapshot-carried Questions state (RemoteTabState.questions) for
    /// every tab in a full snapshot. Snapshot is authoritative: a tab with no
    /// questions field clears any lingering local state (first paint and
    /// seq-gap recovery both come through here).
    @MainActor
    func mergeQuestionsFromSnapshot(_ snapshotTabs: [RemoteTabState]) {
        for tab in snapshotTabs {
            questionsStore.replaceFromSnapshot(tabId: tab.id, workflows: tab.questions)
        }
    }

    /// Send a revisioned draft patch. Local form state stays responsive in
    /// the view; the accepted main state replaces it via the state event.
    @MainActor
    func sendQuestionsPatch(tabId: String, workflow: QuestionsWorkflowState, answers: [QuestionDraftAnswer]?, comment: String?) {
        let patch = QuestionsPatch(
            workflowId: workflow.workflowId,
            requestId: workflow.requestId,
            expectedRevision: workflow.revision,
            actionId: UUID().uuidString,
            answers: answers,
            comment: comment
        )
        send(.questionsPatch(tabId: tabId, patch: patch), intent: .userInitiated)
        DiagnosticLog.log("questions patch sent", tag: "questions", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "workflow_id": workflow.workflowId,
            "revision": String(workflow.revision),
        ])
    }

    /// Send a workflow action (enter_review / edit_question / request_more /
    /// final_confirm / cancel). Submit-bearing actions pass the final local
    /// draft inline so the desktop applies draft + transition atomically in
    /// one revision step (the CAS-race fix — never patch-then-action).
    @MainActor
    func sendQuestionsAction(
        tabId: String,
        workflow: QuestionsWorkflowState,
        kind: String,
        questionId: String? = nil,
        answers: [QuestionDraftAnswer]? = nil,
        comment: String? = nil
    ) {
        let action = QuestionsAction(
            workflowId: workflow.workflowId,
            requestId: workflow.requestId,
            expectedRevision: workflow.revision,
            actionId: UUID().uuidString,
            kind: kind,
            questionId: questionId,
            answers: answers,
            comment: comment
        )
        send(.questionsAction(tabId: tabId, action: action), intent: .userInitiated)
        DiagnosticLog.log("questions action sent", tag: "questions", fields: [
            "tab_id": String(tabId.prefix(8)),
            "workflow_id": workflow.workflowId,
            "action": kind,
        ])
    }

    /// Request the authoritative state for one tab (reconnect, seq loss).
    @MainActor
    func refreshQuestions(tabId: String) {
        send(.questionsRefresh(tabId: tabId), intent: .userInitiated)
    }
}
