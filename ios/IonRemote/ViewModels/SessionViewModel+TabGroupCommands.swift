import Foundation

// MARK: - Tab-group commands
//
// This file holds the SessionViewModel commands that mutate tab-group
// state on the desktop: mode switches, moves, pins, and reordering. It
// was split out of SessionViewModel+Commands.swift when the latter
// crossed the 600-line Swift size cap — see CLAUDE.md → "When a file
// exceeds the cap". The seam is natural: every method here corresponds
// to a tab-group concept, distinct from generic per-tab actions
// (createTab, closeTab, prompt) and from terminal/engine commands.

extension SessionViewModel {

    /// Request the desktop to change the tab group mode.
    func setTabGroupMode(_ mode: String) {
        send(.setTabGroupMode(mode: mode), intent: .userInitiated)
    }

    /// Move a tab to a different manual group on the desktop.
    func moveTabToGroup(tabId: String, groupId: String) {
        // Optimistic local update for responsive UI
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].groupId = groupId
        }
        send(.moveTabToGroup(tabId: tabId, groupId: groupId), intent: .userInitiated)
    }

    /// Combined "move to group AND pin" — used by the "Move to Group and Pin"
    /// row in the iOS tab-row context menu. The desktop has a single store
    /// action that does both atomically, but the wire protocol still uses
    /// two ordered commands (no dedicated `move_and_pin` command): the move
    /// goes first, then the pin toggle. This mirrors the `implementPlan`
    /// pattern in SessionViewModel+Commands.swift for sequenced commands.
    ///
    /// We guard the toggle on the *current* pin state so we don't accidentally
    /// flip an already-pinned tab off. The optimistic local update sets
    /// `groupPinned = true` unconditionally; the wire toggle is skipped if
    /// the tab was already pinned (avoids a redundant round-trip).
    func moveTabToGroupAndPin(tabId: String, groupId: String) {
        let wasPinned = tabs.first(where: { $0.id == tabId })?.groupPinned ?? false
        // Optimistic local update — set both fields immediately so the UI
        // reflects the final state without waiting for the desktop snapshot.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].groupId = groupId
            tabs[idx].groupPinned = true
        }
        guard let transport else {
            Task { @MainActor [weak self] in
                self?.showToast(ToastMessage(style: .error, title: "Not connected", detail: "Command could not be sent"))
            }
            return
        }
        // Chain the two commands through the transport in order. We do NOT
        // use the convenience `send(...)` helper here because that fires the
        // command on a new Task without ordering guarantees relative to a
        // sibling Task; using a single Task that awaits both keeps the
        // move strictly before the pin toggle on the wire.
        DiagnosticLog.logCommand(.moveTabToGroup(tabId: tabId, groupId: groupId))
        if !wasPinned {
            DiagnosticLog.logCommand(.toggleTabGroupPin(tabId: tabId))
        } else {
            DiagnosticLog.log("CMD: moveTabToGroupAndPin: tab already pinned, skipping toggle")
        }
        Task { [weak self] in
            do {
                try await transport.send(.moveTabToGroup(tabId: tabId, groupId: groupId))
                if !wasPinned {
                    try await transport.send(.toggleTabGroupPin(tabId: tabId))
                }
            } catch {
                let detail = error.localizedDescription
                await MainActor.run {
                    self?.showToast(ToastMessage(style: .error, title: "Send failed", detail: detail))
                }
            }
        }
    }

    /// Toggle the group-pin state for a tab on the desktop.
    func toggleTabGroupPin(tabId: String) {
        // Optimistic local update for responsive UI
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].groupPinned = !(tabs[idx].groupPinned ?? false)
        }
        send(.toggleTabGroupPin(tabId: tabId), intent: .userInitiated)
    }

    /// Reorder tab groups. Sends the new ordering to the desktop.
    func reorderTabGroups(orderedIds: [String]) {
        // Optimistic local update: reorder tabGroups to match orderedIds
        let idOrder = Dictionary(uniqueKeysWithValues: orderedIds.enumerated().map { ($1, $0) })
        tabGroups.sort { (idOrder[$0.id] ?? Int.max) < (idOrder[$1.id] ?? Int.max) }
        for i in tabGroups.indices {
            tabGroups[i].order = i
        }
        send(.reorderTabGroups(orderedIds: orderedIds), intent: .userInitiated)
    }
}
