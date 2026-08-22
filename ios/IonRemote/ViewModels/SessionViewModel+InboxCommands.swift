import Foundation

// MARK: - Inbox commands (settle / snooze / mark-unread)
//
// Extracted from SessionViewModel+Commands.swift at the Swift 600-line cap.
// Fire-and-forget commands; the desktop routes each into the owner
// renderer's forwarded store action and the next snapshot converges every
// client. No optimistic local mutation: inboxState is a desktop-derived
// field iOS never computes (parity rule — desktop computes, clients
// render), so the row moves when the snapshot says so.
extension SessionViewModel {

    @MainActor
    func settleTab(tabId: String) {
        send(.tabSettle(tabId: tabId), intent: .userInitiated)
    }

    /// Return a settled conversation to the active workspace.
    ///
    /// Refused when the record settled PERMANENTLY. The desktop states that in
    /// `canRestoreSettled` and every row already hides the verb, so this guard
    /// catches a stale row tapped after the answer changed.
    @MainActor
    func unsettleTab(tabId: String) {
        if let tab = tab(for: tabId) ?? settledTabs.first(where: { $0.id == tabId }),
           tab.canRestoreSettled == false {
            DiagnosticLog.log("un-settle refused for a permanently settled conversation", tag: "inbox", level: .warn, fields: [
                "tab_id": tabId,
                "tab_role": tab.tabRole ?? "none"
            ])
            return
        }
        send(.tabUnsettle(tabId: tabId), intent: .userInitiated)
    }

    /// Whether settling this conversation ends it for good.
    ///
    /// Mirrors settlingIsPermanent in the desktop's shared/worktree-conversations
    /// and reads the same stored role. A bench conversation's checkout is rebuilt
    /// from its members' pins, and a machine conversation was never typeable, so
    /// neither can be returned to active work.
    @MainActor
    func settlingIsPermanent(_ tab: RemoteTabState) -> Bool {
        switch tab.tabRole {
        case "bench-conversation", "conflict-auto-fix", "verification-analysis": return true
        default: return false
        }
    }

    /// Park a conversation until a wake time.
    ///
    /// A bench conversation is refused. A bench is rebuildable scratch space:
    /// the next assembly recreates its branch and deletes everything in it, so
    /// parking one for later promises a future that cannot arrive. The desktop
    /// store refuses the same case, and the affordance is absent from the row,
    /// so this guard only catches a stale row whose directory moved into a
    /// bench between render and tap.
    @MainActor
    func snoozeTab(tabId: String, untilMs: Double) {
        if let tab = tab(for: tabId), isBenchConversation(tab) {
            DiagnosticLog.log("snooze refused for a bench conversation", tag: "inbox", level: .warn, fields: [
                "tab_id": tabId,
                "working_directory": tab.workingDirectory
            ])
            return
        }
        send(.tabSnooze(tabId: tabId, untilMs: untilMs), intent: .userInitiated)
    }

    /// Whether a conversation lives in an integration bench, or below one.
    /// Mirrors isBenchDirectory in the desktop's shared/worktree-conversations.
    @MainActor
    func isBenchConversation(_ tab: RemoteTabState) -> Bool {
        let directory = tab.workingDirectory
        guard !directory.isEmpty else { return false }
        return worktreeStates.values.contains { state in
            state.benches.contains { directory == $0.benchPath || directory.hasPrefix($0.benchPath + "/") }
        }
    }

    @MainActor
    func unsnoozeTab(tabId: String) {
        send(.tabUnsnooze(tabId: tabId), intent: .userInitiated)
    }

    @MainActor
    func markTabUnread(tabId: String) {
        send(.tabMarkUnread(tabId: tabId), intent: .userInitiated)
    }

    @MainActor
    func pinTab(tabId: String) {
        send(.tabPin(tabId: tabId), intent: .userInitiated)
    }

    @MainActor
    func unpinTab(tabId: String) {
        send(.tabUnpin(tabId: tabId), intent: .userInitiated)
    }

    @MainActor
    func reorderPinnedTabs(assignments: [PinOrderAssignment]) {
        send(.tabReorderPin(assignments: assignments), intent: .userInitiated)
    }

    @MainActor
    func regenerateTabTitle(tabId: String) {
        send(.tabRegenerateTitle(tabId: tabId), intent: .userInitiated)
    }

    @MainActor
    func reviewSettledTab(tabId: String) {
        send(.reviewSettledTab(tabId: tabId), intent: .userInitiated)
    }

}
