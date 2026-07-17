import Foundation

// MARK: - Dispatch transcript management
//
// Extracted from SessionViewModel+EngineEvents.swift. Owns the two functions
// that maintain the per-dispatch push transcript and merge it with the
// file-backed snapshot:
//
//   handleDispatchActivity  — folds a single engine_dispatch_activity delta
//                             into the keyed push buffer.
//   recomputeDispatchTranscript — merges the snapshot authority with in-flight
//                             push entries into agentConversationMessages[convId].
//
// These functions are keyed by dispatchAgentId (NOT conversationId) because a
// re-dispatched agent reuses the same child conversationId but the engine issues
// a new dispatchAgentId with seq reset to 0 for each dispatch. ConvId-keying
// would collide the two dispatches' push buffers.

extension SessionViewModel {

    /// Fold one engine_dispatch_activity delta into the per-dispatch push
    /// transcript (deduped by toolId for tools, by seq for streamed text) and
    /// recompute the merged transcript the popup reads. This is the iOS push
    /// half of the live dispatched-agent transcript. Mirrors the desktop fold in
    /// agent-dispatch-activity.ts. Cross-cutting — never touches the main
    /// conversation messages.
    @MainActor
    func handleDispatchActivity(dispatchAgentId: String, conversationId: String, kind: String, seq: Int, ts: Int64?, toolName: String?, toolId: String?, textDelta: String?, isError: Bool) {
        guard !dispatchAgentId.isEmpty else {
            DiagnosticLog.log("dispatch activity missing dispatch id", tag: "session.dispatch", level: .warn, fields: [
                "conversation_id": conversationId,
                "reason": kind,
                "count": String(seq)
            ])
            return
        }
        // Track convId -> dispatchAgentId so the snapshot reconcile path can
        // find the active push buffer when it only has the convId.
        if !conversationId.isEmpty {
            activeDispatchIdByConvId[conversationId] = dispatchAgentId
        }
        var entries = agentDispatchActivity[dispatchAgentId] ?? []
        var seqs   = agentDispatchSeqs[dispatchAgentId] ?? []
        let entryTs = Double(ts ?? 0)

        if kind == "tool_start" || kind == "tool_end" {
            let tid = toolId ?? "seq-\(seq)"
            let status: ToolStatus = kind == "tool_end" ? (isError ? .error : .completed) : .running
            if let idx = entries.firstIndex(where: { $0.role == .tool && $0.toolId == tid }) {
                // tool_end updates the existing tool entry in place (dedupe).
                var msg = entries[idx]
                msg.toolStatus = status
                entries[idx] = msg
                // seq array stays in sync; no positional change on update.
                DiagnosticLog.log("dispatch activity fold", tag: "session.dispatch", fields: [
                    "run_id": dispatchAgentId,
                    "conversation_id": conversationId,
                    "reason": kind,
                    "tool": tid,
                    "count": String(seq),
                    "status": "tool-updated"
                ])
            } else {
                let msg = Message(id: tid, role: .tool, content: "", toolName: toolName ?? "", toolId: tid, toolStatus: status, timestamp: entryTs)
                entries.append(msg)
                seqs.append(seq)
                DiagnosticLog.log("dispatch activity fold", tag: "session.dispatch", fields: [
                    "run_id": dispatchAgentId,
                    "conversation_id": conversationId,
                    "reason": kind,
                    "tool": tid,
                    "count": String(seq),
                    "status": "tool-added"
                ])
            }
        } else {
            // text: keyed by seq so a coalesced run updates in place.
            let textId = "dispatch-text-\(seq)"
            if let idx = entries.firstIndex(where: { $0.id == textId }) {
                var msg = entries[idx]
                msg.content = textDelta ?? ""
                entries[idx] = msg
                // seq array stays in sync; no positional change on update.
                DiagnosticLog.log("dispatch activity fold", tag: "session.dispatch", fields: [
                    "run_id": dispatchAgentId,
                    "conversation_id": conversationId,
                    "reason": "text",
                    "count": String(seq),
                    "status": "text-updated"
                ])
            } else {
                let msg = Message(id: textId, role: .assistant, content: textDelta ?? "", timestamp: entryTs)
                entries.append(msg)
                seqs.append(seq)
                DiagnosticLog.log("dispatch activity fold", tag: "session.dispatch", fields: [
                    "run_id": dispatchAgentId,
                    "conversation_id": conversationId,
                    "reason": "text",
                    "count": String(seq),
                    "status": "text-added"
                ])
            }
        }

        // Sort by (ts primary, seq tiebreaker) using a stable zip-sort so
        // equal-key entries preserve their relative insertion order.
        // seqs is kept in lockstep with entries so each position has a known seq.
        // This mirrors activityMessages in agent-dispatch-activity.ts.
        let paired = zip(entries, seqs).map { (entry: $0.0, seq: $0.1) }
        let sortedPaired = paired.enumerated().sorted { lhs, rhs in
            let lhsTs = lhs.element.entry.timestamp ?? 0
            let rhsTs = rhs.element.entry.timestamp ?? 0
            if lhsTs != rhsTs { return lhsTs < rhsTs }
            let lhsSeq = lhs.element.seq
            let rhsSeq = rhs.element.seq
            if lhsSeq != rhsSeq { return lhsSeq < rhsSeq }
            // Final tiebreaker: original insertion order (stable).
            return lhs.offset < rhs.offset
        }
        entries = sortedPaired.map { $0.element.entry }
        seqs    = sortedPaired.map { $0.element.seq }

        agentDispatchActivity[dispatchAgentId] = entries
        agentDispatchSeqs[dispatchAgentId]     = seqs
        recomputeDispatchTranscript(dispatchAgentId: dispatchAgentId, convId: conversationId)
    }

    /// Merge the file-backed snapshot (authority) with the in-flight push
    /// entries into agentConversationMessages[convId]. The snapshot wins; push
    /// entries the snapshot already covers are dropped to avoid double-render,
    /// while a live partial the snapshot does not yet carry survives.
    ///
    /// Parameters:
    ///   - dispatchAgentId: identifies which push buffer to read from
    ///     (agentDispatchActivity is keyed by dispatchAgentId, not convId).
    ///   - convId: identifies the snapshot to read (agentSnapshotByConvId) and
    ///     the output cache to write (agentConversationMessages).
    ///
    /// When called from handleAgentConversationHistory (which knows convId but
    /// not dispatchAgentId), the caller resolves dispatchAgentId via
    /// activeDispatchIdByConvId — or passes "" to fall back to snapshot-only
    /// (push buffer is empty for terminal dispatches).
    ///
    /// Dedup rules (mirrors reconcileActivity in agent-dispatch-activity.ts):
    ///   - Tools: keyed by toolId. A push tool entry is dropped when the
    ///     snapshot already carries that toolId.
    ///   - Text: TURN-LEVEL COVERAGE, not exact equality and not per-fragment
    ///     matching. The engine (dispatch_activity.go) emits each coalesced text
    ///     flush at a NEW seq carrying only the INCREMENTAL text since the last
    ///     flush — one push assistant entry per flush. Those fragments
    ///     concatenate, in materialized order, to exactly the single finalized
    ///     assistant message the snapshot persists for the turn. So:
    ///       * Concatenate the content of the push assistant entries (in
    ///         materialized order) into one string `pushTextRun`.
    ///       * The run is COVERED when some snapshot assistant message
    ///         (non-empty content) has content that STARTS WITH `pushTextRun`
    ///         (prefix, which includes equality). Coverage drops ALL the run's
    ///         text fragments at once.
    ///       * If no snapshot assistant message covers the concatenation, the run
    ///         is a genuinely newer in-flight partial the snapshot has not caught
    ///         up to → KEEP all its text fragments (do not drop).
    @MainActor
    func recomputeDispatchTranscript(dispatchAgentId: String, convId: String) {
        let snapshot = agentSnapshotByConvId[convId] ?? []
        // Read push buffer by dispatchAgentId; fall back to empty when no buffer
        // exists for this dispatch (terminal or not yet started).
        let push = dispatchAgentId.isEmpty ? [] : (agentDispatchActivity[dispatchAgentId] ?? [])
        let snapshotTextCount = snapshot.filter { $0.role == .assistant && !$0.content.isEmpty }.count
        let snapshotToolCount = snapshot.compactMap { $0.toolId }.count
        DiagnosticLog.log("dispatch merge enter", tag: "session.dispatch", fields: [
            "run_id": dispatchAgentId,
            "conversation_id": convId,
            "count": String(snapshot.count),
            "attempt": String(snapshotTextCount),
            "max": String(snapshotToolCount),
            "status": String(push.count)
        ])
        if push.isEmpty {
            agentConversationMessages[convId] = snapshot
            DiagnosticLog.log("dispatch merge exit snapshot only", tag: "session.dispatch", fields: [
                "run_id": dispatchAgentId,
                "conversation_id": convId,
                "count": String(snapshot.count)
            ])
            return
        }
        let snapshotToolIds = Set(snapshot.compactMap { $0.toolId })
        let snapshotAssistantContents = snapshot
            .filter { $0.role == .assistant && !$0.content.isEmpty }
            .map { $0.content }
        // Concatenate ONLY the assistant-role push entries, in materialized
        // order, into the run the snapshot's single finalized message becomes.
        let pushTextRun = push
            .filter { $0.role == .assistant }
            .map { $0.content }
            .joined()
        // Covered when some snapshot assistant message starts with the whole
        // concatenation (prefix, incl. equality). Empty run → never covered
        // (nothing to drop); a snapshot with no assistant messages → never covers.
        let textRunCovered = !pushTextRun.isEmpty
            && snapshotAssistantContents.contains { $0.hasPrefix(pushTextRun) }
        var droppedTool = 0
        var droppedText = 0
        let surviving = push.filter { m in
            if m.role == .tool, let tid = m.toolId {
                if snapshotToolIds.contains(tid) { droppedTool += 1; return false }
                return true
            }
            if m.role == .assistant {
                // Drop ALL text fragments only when the snapshot covers the whole
                // run; otherwise keep them (genuinely newer in-flight partial).
                if textRunCovered { droppedText += 1; return false }
                return true
            }
            return true
        }
        let merged = snapshot + surviving
        agentConversationMessages[convId] = merged
        let rowDump = merged.map { m -> String in
            switch m.role {
            case .tool:
                let tid = m.toolId.map { String($0.prefix(8)) } ?? "?"
                return "tool(\(tid))"
            case .assistant:
                let preview = String(m.content.prefix(20)).replacingOccurrences(of: "\n", with: "↵")
                return "asst(\"\(preview)\")"
            default:
                return "\(m.role)"
            }
        }.joined(separator: " | ")
        DiagnosticLog.log("dispatch merge exit", tag: "session.dispatch", fields: [
            "run_id": dispatchAgentId,
            "conversation_id": convId,
            "count": String(merged.count),
            "max": String(surviving.count),
            "attempt": String(push.count - surviving.count),
            "reason": rowDump
        ])
    }
}
