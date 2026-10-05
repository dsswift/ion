import Foundation

// MARK: - Conversation branches

extension SessionViewModel {

    /// Reads the conversation's branches. Asked again whenever the transcript
    /// changes length while idle, so the count reflects a fresh rewind.
    func requestBranches(tabId: String) {
        DiagnosticLog.log("request branches", tag: "session.branches", fields: ["tab_id": String(tabId.prefix(8))])
        send(.listBranches(tabId: tabId), intent: .automaticEssential)
    }

    /// Makes the branch ending at `leafId` the active path. The new
    /// transcript arrives on its own; this only tracks the request.
    func switchBranch(tabId: String, leafId: String) {
        guard branchSwitchPending[tabId] == nil else {
            DiagnosticLog.log("switch branch ignored, one is in flight", tag: "session.branches", level: .debug, fields: [
                "tab_id": String(tabId.prefix(8)), "leaf_id": leafId,
            ])
            return
        }
        DiagnosticLog.log("switch branch", tag: "session.branches", fields: ["tab_id": String(tabId.prefix(8)), "leaf_id": leafId])
        branchSwitchPending[tabId] = leafId
        branchSwitchError[tabId] = nil
        send(.switchBranch(tabId: tabId, leafId: leafId), intent: .userInitiated)
    }

    func handleConversationBranches(tabId: String, listing: ConversationBranches) {
        DiagnosticLog.log("branches received", tag: "session.branches", fields: [
            "tab_id": String(tabId.prefix(8)), "count": String(listing.branches.count), "leaf_id": listing.activeLeafId,
        ])
        conversationBranches[tabId] = listing
    }

    func handleBranchSwitchResult(tabId: String, error: String?) {
        let leafId = branchSwitchPending.removeValue(forKey: tabId) ?? ""
        if let error {
            DiagnosticLog.log("switch branch refused", tag: "session.branches", level: .warn, fields: [
                "tab_id": String(tabId.prefix(8)), "leaf_id": leafId, "error": error,
            ])
            branchSwitchError[tabId] = error
            return
        }
        DiagnosticLog.log("switch branch accepted", tag: "session.branches", fields: ["tab_id": String(tabId.prefix(8)), "leaf_id": leafId])
        requestBranches(tabId: tabId)
    }
}
