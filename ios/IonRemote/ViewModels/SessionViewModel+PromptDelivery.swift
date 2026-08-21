import Foundation

extension SessionViewModel {

    /// Applies desktop_prompt_result to the optimistic message carrying the same
    /// clientMsgId. A relay write is never delivery proof: only this desktop
    /// acknowledgment may mark the local user turn accepted.
    @MainActor
    func handlePromptResult(tabId: String, clientMsgId: String, status: String, error: String?) {
        let accepted = status == "accepted"
        let delivery: PromptDeliveryState = accepted ? .accepted : .rejected(error: error)
        var found = false
        mutateConversationMessages(tabId: tabId) { messages in
            guard let index = messages.firstIndex(where: { $0.id == clientMsgId }) else { return }
            messages[index].deliveryState = delivery
            found = true
        }
        DiagnosticLog.log("prompt delivery result", tag: "session.delivery", level: accepted ? .info : .warn, fields: [
            "tab_id": String(tabId.prefix(8)),
            "client_msg_id": String(clientMsgId.prefix(8)),
            "status": status,
            "found": String(found),
            "error": error ?? "",
        ])
        guard !accepted else { return }
        if let index = tabs.firstIndex(where: { $0.id == tabId }), tabs[index].status == .connecting {
            tabs[index].status = .idle
        }
        showToast(ToastMessage(style: .error, title: "Message not delivered", detail: error ?? "Desktop rejected this prompt"))
    }

    /// Handles desktop_engine_rewind_result — sent ONLY when the desktop's
    /// transactional rewind was REJECTED by the engine (unknown/foreign-branch/
    /// non-user target). A successful rewind stays silent (observable through
    /// the existing history/prefill push); without this handler a refused
    /// rewind left the user with an unchanged transcript and zero feedback
    /// that the tap did anything.
    @MainActor
    func handleEngineRewindResult(tabId: String, instanceId: String, error: String?) {
        DiagnosticLog.log("engine rewind rejected", tag: "session.commands", level: .warn, fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": String(instanceId.prefix(8)),
            "error": error ?? "",
        ])
        showToast(ToastMessage(style: .error, title: "Rewind not applied", detail: error ?? "Desktop rejected this rewind"))
    }
}
