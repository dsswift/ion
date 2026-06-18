import Foundation

// MARK: - Extended-thinking event handlers (issue #158)
//
// Binds the three desktop_thinking_* events into a per-instance reasoning
// row in the engine conversation:
//
//   block_start → append a live `.thinking` Message and remember its id in
//                 `thinkingInProgress` (keyed by engine compound key).
//   delta       → append `thinkingText` to that live message's content. May
//                 NOT arrive (low-bandwidth / streamThinkingToRemote off /
//                 redacted block) — in which case the row stays summary-only.
//   block_end   → finalize: mark the message inactive, stamp the summary
//                 fields (elapsed / tokens / redacted), and forget the id.
//
// The `.thinking` message flows inline through the existing
// engineMsgs → groupedMessages → ChatCollectionView pipeline so reasoning
// renders in turn order, before the assistant text it preceded. The row
// itself (collapsed-by-default) is ThinkingRowView, dispatched from
// EngineMessageRow's role switch.
//
// Three render states (mirroring desktop), all driven off the single
// `.thinking` Message:
//   1. Live: thinkingActive == true; content accumulates deltas; activity
//      indicator shown.
//   2. Historical with text: thinkingActive == false and content non-empty;
//      full text expandable.
//   3. Summary-only: thinkingActive == false and content empty; shows
//      "💭 Thought for {n}s" (+ token estimate) or "🔒 redacted reasoning".
//
// Stream-reset semantics: `thinkingInProgress` is cleared whenever the
// conversation is reloaded (engineConversationHistory), an instance is
// removed, or transient state is wiped — so a block that never received its
// block_end (transport drop mid-reasoning) never leaves a permanently
// "thinking…" row bound to a stale message id. See clearThinkingAccumulator.

extension SessionViewModel {

    /// A reasoning block began. Append a fresh live `.thinking` message and
    /// record its id so subsequent deltas / the block_end can find it. If a
    /// previous block for this instance never closed (no block_end), we
    /// finalize it defensively first so the scrollback never shows two live
    /// thinking rows at once.
    @MainActor
    func handleEngineThinkingBlockStart(tabId: String, instanceId: String?) {
        let key = resolveEngineKey(tabId: tabId, instanceId: instanceId)
        DiagnosticLog.log("ENGINE: thinking-block-start key=\(key.prefix(16))")

        // Defensive close of any orphaned in-progress block for this key.
        finalizeInProgressThinking(key: key, tabId: tabId, instanceId: instanceId,
                                   totalTokens: nil, elapsedSeconds: nil, redacted: nil)

        let msgId = UUID().uuidString
        let msg = Message(
            id: msgId,
            role: .thinking,
            content: "",
            timestamp: Date().timeIntervalSince1970 * 1000,
            thinkingActive: true
        )
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
        thinkingInProgress[key] = msgId
    }

    /// An incremental chunk of reasoning text arrived. Append it to the live
    /// thinking message. No-op when no block is in progress (a stray delta
    /// after block_end, or before block_start) — we never synthesize a row
    /// from a delta alone, so the boundary contract stays authoritative.
    @MainActor
    func handleEngineThinkingDelta(tabId: String, instanceId: String?, thinkingText: String) {
        guard !thinkingText.isEmpty else { return }
        let key = resolveEngineKey(tabId: tabId, instanceId: instanceId)
        guard let msgId = thinkingInProgress[key] else { return }
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let idx = inst.messages.lastIndex(where: { $0.id == msgId }) {
                inst.messages[idx].content += thinkingText
            }
        }
    }

    /// The reasoning block finished. Finalize the live thinking message with
    /// the summary fields and forget the in-progress id. Tolerates a missing
    /// block_start (some transports could drop it): when no live message
    /// exists but the block carried a summary (elapsed / tokens / redacted),
    /// we still append a summary-only row so the user sees that reasoning
    /// happened.
    @MainActor
    func handleEngineThinkingBlockEnd(
        tabId: String,
        instanceId: String?,
        totalTokens: Int?,
        elapsedSeconds: Double?,
        redacted: Bool?
    ) {
        let key = resolveEngineKey(tabId: tabId, instanceId: instanceId)
        DiagnosticLog.log("ENGINE: thinking-block-end key=\(key.prefix(16)) tokens=\(totalTokens.map(String.init) ?? "nil") elapsed=\(elapsedSeconds.map { String(format: "%.1f", $0) } ?? "nil") redacted=\(redacted ?? false)")

        if thinkingInProgress[key] != nil {
            finalizeInProgressThinking(key: key, tabId: tabId, instanceId: instanceId,
                                       totalTokens: totalTokens, elapsedSeconds: elapsedSeconds, redacted: redacted)
            return
        }

        // No live block (missing block_start). Only synthesize a summary-only
        // row when the block_end actually carried something to show — a bare
        // block_end with no summary and no text is nothing the user can act on.
        let hasSummary = totalTokens != nil || elapsedSeconds != nil || (redacted ?? false)
        guard hasSummary else { return }
        let msg = Message(
            id: UUID().uuidString,
            role: .thinking,
            content: "",
            timestamp: Date().timeIntervalSince1970 * 1000,
            thinkingActive: false,
            thinkingElapsedSeconds: elapsedSeconds,
            thinkingTotalTokens: totalTokens,
            thinkingRedacted: redacted ?? false
        )
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    /// Finalize the live thinking message for `key` (if any): clear the
    /// active flag and stamp the summary fields. Always removes the
    /// in-progress id so a follow-up delta can't reopen a closed block.
    @MainActor
    private func finalizeInProgressThinking(
        key: String,
        tabId: String,
        instanceId: String?,
        totalTokens: Int?,
        elapsedSeconds: Double?,
        redacted: Bool?
    ) {
        guard let msgId = thinkingInProgress[key] else { return }
        thinkingInProgress[key] = nil
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            guard let idx = inst.messages.lastIndex(where: { $0.id == msgId }) else { return }
            inst.messages[idx].thinkingActive = false
            inst.messages[idx].thinkingElapsedSeconds = elapsedSeconds
            inst.messages[idx].thinkingTotalTokens = totalTokens
            inst.messages[idx].thinkingRedacted = redacted ?? false
        }
    }

    /// Clear the in-progress thinking accumulator for one compound key.
    /// Called on conversation reload (engineConversationHistory) and instance
    /// removal so a block that never closed doesn't keep a stale message id
    /// bound after the underlying messages are replaced. This is the iOS
    /// analogue of resetting an in-flight stream accumulator.
    @MainActor
    func clearThinkingAccumulator(forKey key: String) {
        thinkingInProgress.removeValue(forKey: key)
    }
}
