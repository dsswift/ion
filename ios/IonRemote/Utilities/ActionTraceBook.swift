import Foundation

/// The open client spans of the actions this phone has sent and not yet had
/// answered, keyed by the caller's own id.
///
/// Every action's trace starts on the phone. Its `traceparent` rides the
/// action to the server, whose `action.handle` span
/// joins the trace. The phone's span ends when the server answers, accepted
/// or rejected (a failed or timed-out action answers rejected too), so every
/// span opened here is closed.
///
/// A prompt's span is `prompt.send`, keyed by the prompt's `clientMsgId` and
/// opened by the view model, which needs the traceparent before it builds the
/// command. Every other action's span is `action.send`, keyed by an id the
/// transport mints, with the action's name as its `action` attribute.
final class ActionTraceBook: @unchecked Sendable {

    static let shared = ActionTraceBook()

    static let promptSpanName = "prompt.send"
    static let actionSpanName = "action.send"

    typealias MakeSpan = @Sendable (_ name: String, _ attributes: [String: String], _ conversationId: String?) -> TraceSpan

    private let lock = NSLock()
    private var spans: [String: TraceSpan] = [:]
    private let makeSpan: MakeSpan

    init(makeSpan: @escaping MakeSpan = { name, attributes, conversationId in
        TraceSpan(name: name, kind: .client, attributes: attributes, conversationId: conversationId)
    }) {
        self.makeSpan = makeSpan
    }

    /// Opens the `prompt.send` span for one submitted prompt and returns it.
    func openPrompt(clientMsgId: String, tabId: String, conversationId: String?) -> TraceSpan {
        open(name: Self.promptSpanName, key: clientMsgId, attributes: [
            "tab_id": tabId, "client_msg_id": clientMsgId, "action": "session.prompt"
        ], conversationId: conversationId)
    }

    /// Opens the `action.send` span for one action and returns it.
    func openAction(_ action: String, key: String, tabId: String?, conversationId: String? = nil) -> TraceSpan {
        var attributes = ["action": action]
        if let tabId { attributes["tab_id"] = tabId }
        return open(name: Self.actionSpanName, key: key, attributes: attributes, conversationId: conversationId)
    }

    private func open(name: String, key: String, attributes: [String: String], conversationId: String?) -> TraceSpan {
        // peer.service names the callee, so a trace backend names the
        // dependency's target.
        var stamped = attributes
        stamped["surface"] = "ios"
        stamped["peer.service"] = "ion-server"
        let span = makeSpan(name, stamped, conversationId)
        lock.withLock { spans[key] = span }
        return span
    }

    /// Ends the span with the server's answer. Nil when no span is open under
    /// `key` (an answer to an action from before this launch).
    @discardableResult
    func close(key: String, accepted: Bool, error: String?) -> TraceSpan.Record? {
        guard let span = lock.withLock({ spans.removeValue(forKey: key) }) else { return nil }
        return span.end(
            attributes: ["accepted": accepted ? "true" : "false"],
            error: accepted ? nil : (error ?? "action rejected")
        )
    }

    /// How many spans are open. For tests.
    var openCount: Int { lock.withLock { spans.count } }
}
