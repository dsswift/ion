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
}
