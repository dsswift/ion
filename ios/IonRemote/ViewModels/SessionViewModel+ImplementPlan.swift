import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Plan→Implement Flow
//
// This file owns iOS's side of the plan-approval → implement-phase
// transition. See SessionViewModel+ImplementPlan.swift for history.
//
// CHANGE (plan gentle-perching-lemon): iOS no longer builds the implement
// prompt string or sends resetTabSession + setPermissionMode + prompt
// manually. Instead it sends a single `implement_plan` command carrying
// only the intent (tabId + questionId + optional clearContext). The desktop
// runs the full onImplement pipeline internally — resolves the plan file,
// reads it from disk, sets permission mode, inserts the divider, and calls
// processIncomingPrompt with implementationPhase=true. No plan body crosses
// the wire in either direction.
//
// iOS retains the optimistic local update (permissionMode→auto,
// status→connecting) for immediate UI responsiveness.
//
// Desktop counterpart: desktop/src/main/remote/handlers/implement-plan.ts

extension SessionViewModel {

    // MARK: - Implement intent

    /// Send an implement_plan command to the desktop. The desktop drives the
    /// full implement pipeline; iOS sends intent only (no prompt, no plan body).
    ///
    /// `clearContext` maps to the "Implement, clear context" secondary button —
    /// the desktop resets the engine session before implementing. Default false
    /// preserves the planning conversation.
    func sendImplementPlanIntent(tabId: String, questionId: String, clearContext: Bool = false) {
        let hasEngineExtension = tabs.first(where: { $0.id == tabId })?.hasEngineExtension == true
        let instanceId = hasEngineExtension
            ? activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
            : nil

        // Optimistic local update for responsive UI — same as before.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].permissionMode = .auto
            tabs[idx].status = .connecting
        }

        DiagnosticLog.log("IMPL-PLAN: sendImplementPlanIntent tabId=\(tabId.prefix(8)) qId=\(questionId.prefix(12)) clearContext=\(clearContext) engine=\(hasEngineExtension)")

        guard let transport else {
            Task { @MainActor [weak self] in
                self?.showToast(ToastMessage(style: .error, title: "Not connected", detail: "Command could not be sent"))
            }
            return
        }
        Task { [weak self] in
            do {
                try await transport.send(.implementPlan(
                    tabId: tabId,
                    questionId: questionId,
                    instanceId: instanceId,
                    clearContext: clearContext
                ))
            } catch {
                let detail = error.localizedDescription
                await MainActor.run {
                    self?.showToast(ToastMessage(style: .error, title: "Send failed", detail: detail))
                }
            }
        }
    }

    // MARK: - Implement + unpin (ordered)

    /// Unpin the tab from its group, then send the implement_plan command in a
    /// single awaited Task so the unpin wire command is guaranteed to arrive at
    /// the desktop BEFORE implement_plan.
    ///
    /// The desktop's implement-plan handler suppresses auto-grouping only when
    /// `!tab.groupPinned` — so the unpin must complete before the implement
    /// command is processed. Firing the two commands in separate Tasks (the old
    /// `implementAndUnpin` code) gives no ordering guarantee; this method fixes
    /// that by chaining them in one Task with sequential `try await` calls,
    /// following the same pattern as `moveTabToGroupAndPin` in
    /// SessionViewModel+TabGroupCommands.swift.
    ///
    /// Mirrors the optimistic-update and diagnostic-logging discipline of
    /// `sendImplementPlanIntent` and `moveTabToGroupAndPin`.
    func sendUnpinThenImplementPlanIntent(tabId: String, questionId: String, clearContext: Bool = false) {
        let hasEngineExtension = tabs.first(where: { $0.id == tabId })?.hasEngineExtension == true
        let instanceId = hasEngineExtension
            ? activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
            : nil

        // Optimistic local update: unpin and advance status immediately so the
        // UI reflects the final state without waiting for a desktop snapshot.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].groupPinned = false
            tabs[idx].permissionMode = .auto
            tabs[idx].status = .connecting
        }

        DiagnosticLog.log("IMPL-PLAN: sendUnpinThenImplementPlanIntent tabId=\(tabId.prefix(8)) qId=\(questionId.prefix(12)) clearContext=\(clearContext) engine=\(hasEngineExtension)")
        DiagnosticLog.logCommand(.toggleTabGroupPin(tabId: tabId))
        DiagnosticLog.logCommand(.implementPlan(tabId: tabId, questionId: questionId, instanceId: instanceId, clearContext: clearContext))

        guard let transport else {
            Task { @MainActor [weak self] in
                self?.showToast(ToastMessage(style: .error, title: "Not connected", detail: "Command could not be sent"))
            }
            return
        }
        // Chain both commands through the transport in order. We do NOT use
        // the convenience `send(...)` helper here because that fires the
        // command on a new Task without ordering guarantees relative to a
        // sibling Task; using a single Task that awaits both keeps the
        // unpin strictly before implement_plan on the wire.
        Task { [weak self] in
            do {
                try await transport.send(.toggleTabGroupPin(tabId: tabId))
                try await transport.send(.implementPlan(
                    tabId: tabId,
                    questionId: questionId,
                    instanceId: instanceId,
                    clearContext: clearContext
                ))
            } catch {
                let detail = error.localizedDescription
                await MainActor.run {
                    self?.showToast(ToastMessage(style: .error, title: "Send failed", detail: detail))
                }
            }
        }
    }

    // MARK: - Plan content paging

    /// Initiate a paged fetch of the plan body from the desktop. Sends the
    /// first `request_plan_content` command (offset=0, length=0 → server
    /// default 64 KB). Subsequent pages are driven automatically by
    /// `requestNextPlanPage` via the plan_content event handler in
    /// SessionViewModel+EventHandlers.swift when hasMore=true arrives.
    ///
    /// Safe to call multiple times for the same questionId — the store
    /// guards against duplicate fetches once complete.
    func startPlanContentFetch(tabId: String, questionId: String, planFilePath: String) {
        guard !planContentStore.isComplete(questionId: questionId),
              !planContentStore.isFetching(questionId: questionId) else {
            DiagnosticLog.log("IMPL-PLAN: startPlanContentFetch skip — already fetching or complete questionId=\(questionId.prefix(12))")
            return
        }
        planContentStore.markFetching(questionId: questionId, tabId: tabId)
        DiagnosticLog.log("IMPL-PLAN: startPlanContentFetch questionId=\(questionId.prefix(12)) planFilePath=\(planFilePath.suffix(40))")
        guard let transport else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                try await transport.send(.requestPlanContent(
                    tabId: tabId,
                    questionId: questionId,
                    planFilePath: planFilePath,
                    offset: 0,
                    length: 0   // server default = 64 KB
                ))
            } catch {
                DiagnosticLog.log("IMPL-PLAN: startPlanContentFetch send failed: \(error.localizedDescription)")
            }
        }
    }

    /// Request the next page of plan content when hasMore=true arrived.
    /// Called from the plan_content event handler in EventHandlers.
    func requestNextPlanPage(questionId: String, planFilePath: String, nextOffset: Int) {
        let tabId = planContentStore.tabId(for: questionId)
        guard !tabId.isEmpty, let transport else {
            DiagnosticLog.log("IMPL-PLAN: requestNextPlanPage skip — no tabId or transport questionId=\(questionId.prefix(12))")
            return
        }
        DiagnosticLog.log("IMPL-PLAN: requestNextPlanPage questionId=\(questionId.prefix(12)) nextOffset=\(nextOffset)")
        Task { [weak self] in
            guard let self else { return }
            do {
                try await transport.send(.requestPlanContent(
                    tabId: tabId,
                    questionId: questionId,
                    planFilePath: planFilePath,
                    offset: nextOffset,
                    length: 0   // server default = 64 KB
                ))
            } catch {
                DiagnosticLog.log("IMPL-PLAN: requestNextPlanPage send failed: \(error.localizedDescription)")
            }
        }
    }
}
