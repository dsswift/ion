import Foundation

/// The open render spans of this phone: what the person is waiting to see.
///
/// - `prompt.visible`: the submit to the first visible update of the answer in
///   that tab. It is a second root of the prompt's own trace (the one
///   `prompt.send` minted), so the whole round trip reads under one trace id.
///   An incoming transcript patch that carries the engine's `trace_id` closes
///   the prompt it belongs to; a patch without one closes the oldest open
///   prompt of its tab.
/// - `push.open`: a push notification's receipt to its conversation being on
///   screen, a child of the push payload's `traceparent` when the relay
///   forwarded one.
/// - `pairing.complete`: a pairing flow's start to the pairing being stored,
///   or failing.
final class ClientSpanBook: @unchecked Sendable {

    static let shared = ClientSpanBook()

    static let promptVisibleName = "prompt.visible"
    static let pushOpenName = "push.open"
    static let pairingName = "pairing.complete"

    private struct OpenPrompt {
        let clientMsgId: String
        let tabId: String
        let span: TraceSpan
    }

    private let lock = NSLock()
    private var prompts: [OpenPrompt] = []
    private var pushes: [String: TraceSpan] = [:]
    private var pairing: TraceSpan?

    // MARK: - prompt.visible

    /// The person submitted a prompt; its answer is not on screen yet.
    @discardableResult
    func openPromptVisible(clientMsgId: String, tabId: String, traceId: String, conversationId: String?) -> TraceSpan {
        let span = TraceSpan(
            name: Self.promptVisibleName, traceId: traceId,
            attributes: ["tab_id": tabId, "client_msg_id": clientMsgId, "surface": "ios"],
            conversationId: conversationId
        )
        lock.withLock {
            // A prompt the tab never answered is not going to be: the next one is what is waited for now.
            prompts.removeAll { $0.clientMsgId == clientMsgId }
            prompts.append(OpenPrompt(clientMsgId: clientMsgId, tabId: tabId, span: span))
        }
        return span
    }

    /// The traceparent a render span in `tabId` should parent under: the open
    /// `prompt.visible` whose trace the frame names, else the tab's oldest.
    func promptVisibleParent(tabId: String, traceId: String?) -> String? {
        lock.withLock { openPrompt(tabId: tabId, traceId: traceId)?.span.traceparent }
    }

    /// The first visible update of an answer landed in `tabId`. Ends the
    /// prompt it answers and returns the record, or nil when no prompt waited.
    @discardableResult
    func promptBecameVisible(tabId: String, traceId: String?, at now: Date = Date()) -> TraceSpan.Record? {
        let open = lock.withLock { () -> OpenPrompt? in
            guard let found = openPrompt(tabId: tabId, traceId: traceId) else { return nil }
            prompts.removeAll { $0.clientMsgId == found.clientMsgId }
            return found
        }
        return open?.span.end(attributes: ["joined_by": traceId == nil ? "tab" : "trace_id"], at: now)
    }

    /// The server refused the prompt, so nothing will become visible for it.
    @discardableResult
    func promptRejected(clientMsgId: String, error: String?) -> TraceSpan.Record? {
        let open = lock.withLock { () -> OpenPrompt? in
            guard let index = prompts.firstIndex(where: { $0.clientMsgId == clientMsgId }) else { return nil }
            return prompts.remove(at: index)
        }
        return open?.span.end(error: error ?? "prompt rejected")
    }

    /// The conversation is gone (closed, or the pairing was wiped); its
    /// prompts will not render here.
    func abandonPrompts(tabId: String, reason: String) {
        let dropped = lock.withLock { () -> [OpenPrompt] in
            let gone = prompts.filter { $0.tabId == tabId }
            prompts.removeAll { $0.tabId == tabId }
            return gone
        }
        for prompt in dropped { prompt.span.end(error: reason) }
    }

    private func openPrompt(tabId: String, traceId: String?) -> OpenPrompt? {
        if let traceId, let match = prompts.first(where: { $0.span.traceId == traceId }) { return match }
        return prompts.first { $0.tabId == tabId }
    }

    // MARK: - push.open

    /// A push notification for `tabId` was tapped. `parent` is the payload's
    /// `traceparent`, which the relay copies from the server's doorbell.
    @discardableResult
    func openPush(tabId: String, parent: String?) -> TraceSpan {
        let span = TraceSpan(name: Self.pushOpenName, parent: parent, attributes: ["tab_id": tabId, "surface": "ios"])
        let replaced = lock.withLock { pushes.updateValue(span, forKey: tabId) }
        replaced?.end(error: "superseded by a later push")
        return span
    }

    /// `tabId`'s conversation is on screen. Ends its `push.open`, if one is open.
    @discardableResult
    func tabVisible(_ tabId: String, at now: Date = Date()) -> TraceSpan.Record? {
        lock.withLock { pushes.removeValue(forKey: tabId) }?.end(at: now)
    }

    // MARK: - pairing.complete

    /// The pairing state moved. A move out of rest starts the span; `.paired`
    /// ends it; `.failed` ends it failed; a return to `.idle` mid-flow ends it
    /// as cancelled.
    @discardableResult
    func pairingStateChanged(from old: PairingState, to new: PairingState) -> TraceSpan.Record? {
        switch new {
        case .discovering, .connecting, .exchangingKeys, .configuringRelay:
            lock.withLock {
                guard pairing == nil else { return }
                pairing = TraceSpan(name: Self.pairingName, parent: AppLaunchTrace.shared.parentForFirst(Self.pairingName), attributes: [
                    "surface": "ios", "started_as": Self.label(new)
                ])
            }
            return nil
        case .paired:
            return takePairing()?.end(attributes: ["outcome": "paired"])
        case .failed(let error):
            return takePairing()?.end(attributes: ["outcome": "failed"], error: error.localizedDescription)
        case .idle:
            guard !old.isIdle else { return nil }
            return takePairing()?.end(attributes: ["outcome": "cancelled"], error: "pairing cancelled")
        }
    }

    private func takePairing() -> TraceSpan? {
        lock.withLock {
            defer { pairing = nil }
            return pairing
        }
    }

    private static func label(_ state: PairingState) -> String {
        switch state {
        case .idle: return "idle"
        case .discovering: return "discovering"
        case .connecting: return "connecting"
        case .exchangingKeys: return "exchanging_keys"
        case .configuringRelay: return "configuring_relay"
        case .paired: return "paired"
        case .failed: return "failed"
        }
    }

    /// How many prompts and pushes wait. For tests.
    var openPromptCount: Int { lock.withLock { prompts.count } }
    var openPushCount: Int { lock.withLock { pushes.count } }
}
