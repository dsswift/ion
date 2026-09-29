import Foundation

/// The open `prompt.send` spans of prompts this phone sent, keyed by the
/// prompt's `clientMsgId`.
///
/// A prompt's trace starts on the phone the moment the user submits. Its
/// `traceparent` rides the prompt to the server, whose `prompt.handle` span
/// joins the trace. The phone's span ends when the server answers the prompt,
/// accepted or rejected (a failed or timed-out action answers rejected too),
/// so every span opened here is closed.
final class PromptTraceBook: @unchecked Sendable {

    static let shared = PromptTraceBook()

    private let lock = NSLock()
    private var spans: [String: TraceSpan] = [:]
    private let makeSpan: @Sendable (_ attributes: [String: String], _ conversationId: String?) -> TraceSpan

    init(makeSpan: @escaping @Sendable (_ attributes: [String: String], _ conversationId: String?) -> TraceSpan = { attributes, conversationId in
        TraceSpan(name: "prompt.send", kind: .client, attributes: attributes, conversationId: conversationId)
    }) {
        self.makeSpan = makeSpan
    }

    /// Opens the span for one submitted prompt and returns it.
    func open(clientMsgId: String, tabId: String, conversationId: String?) -> TraceSpan {
        // peer.service names the callee, so a trace backend names the
        // dependency's target.
        let span = makeSpan(["tab_id": tabId, "client_msg_id": clientMsgId, "surface": "ios", "peer.service": "ion-server"], conversationId)
        lock.withLock { spans[clientMsgId] = span }
        return span
    }

    /// Ends the prompt's span with the server's answer. Nil when no span is
    /// open for it (a prompt sent before this launch).
    @discardableResult
    func close(clientMsgId: String, accepted: Bool, error: String?) -> TraceSpan.Record? {
        guard let span = lock.withLock({ spans.removeValue(forKey: clientMsgId) }) else { return nil }
        return span.end(
            attributes: ["accepted": accepted ? "true" : "false"],
            error: accepted ? nil : (error ?? "prompt rejected")
        )
    }
}
