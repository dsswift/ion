import Foundation

// MARK: - Pending prompt overlay
//
// A prompt typed on this phone shows at once, before the server has made a row
// for it. It is held here, apart from the transcript, and drawn after it. The
// server stamps the row it makes with the prompt's `clientMsgId`, and publishes
// that row before it answers the prompt, so the overlay row leaves in one of
// two ways:
//
//  - the transcript now holds a row carrying its `clientMsgId` (the normal
//    case: the row the server made replaces it in place), or
//  - the server accepted the prompt without making a row (a command it
//    handled itself), which the prompt result says.
//
// A prompt the server refused stays, marked refused, until the next prompt is
// sent from this conversation.

extension SessionViewModel {

    /// Show `message` (a prompt this phone just sent) until the server's row
    /// for it arrives.
    @MainActor
    func addPendingPrompt(tabId: String, _ message: Message) {
        var pending = pendingPrompts[tabId] ?? []
        let refused = pending.filter { if case .rejected = $0.deliveryState { return true } else { return false } }.count
        pending.removeAll { if case .rejected = $0.deliveryState { return true } else { return false } }
        pending.append(message)
        pendingPrompts[tabId] = pending
        DiagnosticLog.log("pending prompt shown", tag: "transcript.pending", fields: [
            "tab_id": String(tabId.prefix(16)),
            "client_msg_id": String(message.id.prefix(8)),
            "pending": String(pending.count),
            "refused_dropped": String(refused),
        ])
    }

    /// Drop every pending prompt the transcript now holds a row for.
    @MainActor
    func settlePendingPrompts(tabId: String, rows: [Message]) {
        guard let pending = pendingPrompts[tabId], !pending.isEmpty else { return }
        let landed = Set(rows.compactMap(\.clientMsgId))
        let remaining = pending.filter { !landed.contains($0.id) }
        guard remaining.count != pending.count else { return }
        pendingPrompts[tabId] = remaining.isEmpty ? nil : remaining
        DiagnosticLog.log("pending prompt replaced by its transcript row", tag: "transcript.pending", fields: [
            "tab_id": String(tabId.prefix(16)),
            "replaced": String(pending.count - remaining.count),
            "pending": String(remaining.count),
        ])
    }

    /// Apply the server's answer to a prompt this phone sent.
    @MainActor
    func handlePromptResult(tabId: String, clientMsgId: String, status: String, error: String?) {
        let accepted = status == "accepted"
        ActionTraceBook.shared.close(key: clientMsgId, accepted: accepted, error: error)
        if !accepted { ClientSpanBook.shared.promptRejected(clientMsgId: clientMsgId, error: error) }
        var pending = pendingPrompts[tabId] ?? []
        let index = pending.firstIndex(where: { $0.id == clientMsgId })
        if let index {
            if accepted {
                // The server publishes the prompt's row before it answers,
                // so a row it made has already replaced this one. Anything
                // still here is a prompt the server handled without a row.
                pending.remove(at: index)
            } else {
                pending[index].deliveryState = .rejected(error: error)
            }
            pendingPrompts[tabId] = pending.isEmpty ? nil : pending
        }
        DiagnosticLog.log("prompt delivery result", tag: "session.delivery", level: accepted ? .info : .warn, fields: [
            "tab_id": String(tabId.prefix(8)),
            "client_msg_id": String(clientMsgId.prefix(8)),
            "status": status,
            "found": String(index != nil),
            "error": error ?? "",
        ])
        if accepted {
            // A conversation opened before it had an instance has no stream;
            // the prompt just gave it one.
            if transcriptStreams[tabId] == nil {
                requestTranscript(tabId: tabId, reason: "prompt_accepted_without_stream")
            }
            return
        }
        if let tabIndex = tabs.firstIndex(where: { $0.id == tabId }), tabs[tabIndex].status == .connecting {
            tabs[tabIndex].status = .idle
        }
        showToast(ToastMessage(style: .error, title: "Message not delivered", detail: error ?? "Server rejected this prompt"))
    }
}
