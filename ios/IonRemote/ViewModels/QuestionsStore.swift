import Foundation
import SwiftUI

/// Synchronized replica of the desktop's guided-questions workflow state,
/// keyed by tab. The desktop main coordinator is the ONLY workflow owner;
/// this store replaces its state from snapshots (RemoteTabState.questions)
/// and applies desktop_questions_state deltas by revision — newer replaces,
/// equal acknowledges (optimistic state confirmed), older is ignored.
///
/// Lives on SessionViewModel as a stored property (`let questionsStore =
/// QuestionsStore()`); Swift extensions cannot add stored properties, so the
/// command/reconciliation behavior lives in SessionViewModel+Questions.swift
/// while the state lives here.
@Observable
final class QuestionsStore {

    /// Open workflows per tab id, oldest first (desktop openForSession order).
    private(set) var workflowsByTab: [String: [QuestionsWorkflowState]] = [:]

    /// The most recent action result, for optimistic-state reconciliation.
    private(set) var lastActionResult: QuestionsActionResult?

    /// Open (renderable) workflows for a tab. Excludes terminal and
    /// terminal entries — same rule as the desktop's openForSession.
    func openWorkflows(tabId: String) -> [QuestionsWorkflowState] {
        (workflowsByTab[tabId] ?? []).filter(\.isOpen)
    }

    /// The workflow currently presented for a tab (oldest open), or nil.
    func currentWorkflow(tabId: String) -> QuestionsWorkflowState? {
        openWorkflows(tabId: tabId).first
    }

    /// True when the tab has at least one active guided wait (status rollup,
    /// subtitle priority).
    func hasActiveQuestions(tabId: String) -> Bool {
        !openWorkflows(tabId: tabId).isEmpty
    }

    /// Replace one tab's workflows from a full snapshot's
    /// RemoteTabState.questions (authoritative; nil/absent clears).
    func replaceFromSnapshot(tabId: String, workflows: [QuestionsWorkflowState]?) {
        if let workflows, !workflows.isEmpty {
            workflowsByTab[tabId] = workflows.sorted { $0.startedAt < $1.startedAt }
        } else {
            workflowsByTab[tabId] = nil
        }
    }

    /// Apply a desktop_questions_state event. The event carries the FULL
    /// coordinator snapshot; this projects the target tab's rows out of it.
    /// Per-workflow revision rules: newer replaces, equal is an
    /// acknowledgement (keep — it confirms optimistic edits), older is
    /// ignored (a delayed frame must not roll back accepted state).
    func applyStateEvent(tabId: String, state: QuestionsStateSnapshot) {
        lastActionResult = state.lastActionResult
        let incoming = state.workflows
            .filter { $0.sessionKey == tabId }
            .sorted { $0.startedAt < $1.startedAt }
        let existing = workflowsByTab[tabId] ?? []
        var merged: [QuestionsWorkflowState] = []
        for workflow in incoming {
            if let current = existing.first(where: { $0.workflowId == workflow.workflowId }),
               current.revision > workflow.revision {
                // Older frame for a workflow we already advanced past.
                merged.append(current)
                DiagnosticLog.log(
                    "questions: ignored stale workflow revision", tag: "questions", level: .debug,
                    fields: [
                        "workflow_id": workflow.workflowId,
                        "incoming": String(workflow.revision),
                        "current": String(current.revision),
                    ])
            } else {
                merged.append(workflow)
            }
        }
        workflowsByTab[tabId] = merged.isEmpty ? nil : merged
    }

    /// Remove tab-scoped state on tab close.
    func removeTab(_ tabId: String) {
        workflowsByTab[tabId] = nil
    }

    /// Clear everything on hard disconnect or desktop switch
    /// (pairing-scoped state must not survive a different desktop).
    func clearAll() {
        workflowsByTab = [:]
        lastActionResult = nil
    }
}
