import Foundation

// MARK: - Dispatch cache invalidation on new engine session
//
// When the engine binary is replaced (e.g. a bug-fix build installed and
// restarted), iOS holds stale per-dispatch snapshots from the old engine.
// The terminal-skip guard in loadAgentDispatchConversation treats any cached
// agentSnapshotByConvId entry as permanent authority, so a truncated snapshot
// produced by an old engine (e.g. the limit=50 cap) is trusted forever and
// the dispatch popup shows empty tabs that never self-heal.
//
// ## Trigger: StatusFields.sessionId change
//
// The engine embeds a per-session identifier in `StatusFields.sessionId`
// (carried by `engine_status` / `desktop_session_status` events). This ID is
// a conversation key (`<timestamp>-<hex>`) minted when the engine starts a new
// session and does NOT change across snapshot ticks or routine reconnects to
// the same session. It changes only when:
//   a. the engine process restarts (new binary, crash recovery), or
//   b. the user starts a genuinely new engine session on that tab.
//
// Both cases invalidate all cached dispatch snapshots: the new engine may
// return more complete data for conversations the old engine truncated.
//
// ## What is cleared
//
// On a sessionId change for any tab, ALL dispatch caches are cleared (not
// just that tab's). All dispatch snapshots share the same convId keyspace, and
// any convId may have been fetched from the old engine. The cleared maps:
//
//   - agentSnapshotByConvId       — stale file-backed snapshots (may be truncated)
//   - agentConversationMessages   — merged transcripts derived from them
//   - agentDispatchActivity       — push buffers (empty after terminal cleanup,
//                                   but clear defensively to avoid orphaned ids)
//   - agentDispatchSeqs           — seq arrays in lockstep with agentDispatchActivity
//   - terminalClearedDispatches   — edge-gate set; must be cleared so a new load
//                                   can flow through clearTerminalDispatchCaches
//   - agentConversationLoading    — in-flight guard; cleared so fresh loads are
//                                   not blocked by a stale "loading" sentinel
//   - activeDispatchIdByConvId    — convId→dispatchId mapping; no longer valid
//
// ## Flicker risk: none
//
// The popup reads from agentConversationMessages. After clearing, the next
// loadAgentDispatchConversation call (which fires on every popup open when
// the snapshot is absent) issues a fresh load from the new engine. There is
// no intermediate frame where the popup shows empty: the popup was already
// showing empty (the bug), or it triggers a fresh load immediately and shows
// "Loading…" while waiting — which is the correct behaviour for data that
// hasn't been fetched yet.
//
// ## Routine reconnects: not triggered
//
// Transport-level reconnects (e.g. LAN link drop + rejoin) reconnect to the
// SAME engine session, so the sessionId does not change. The clear fires only
// on a strict string inequality between the old and new sessionId. Sessions
// that have never emitted a sessionId (pre-engine or CLI tabs) are skipped
// (empty-string guard).

extension SessionViewModel {

    // MARK: - Dispatch terminal cleanup (Fix B)

    /// When an agent_state update arrives, clear the ephemeral push cache for
    /// any dispatch that has just transitioned to a terminal state (done/error).
    ///
    /// Design:
    ///   - Edge-triggered via terminalClearedDispatches: fires on every
    ///     engineAgentState tick (level-triggered). The set gates the actual
    ///     clear to the first tick a dispatchAgentId becomes terminal, preventing
    ///     repeated recomputeDispatchTranscript calls on every subsequent tick.
    ///
    ///   - Before clearing the push buffer, compare the merged transcript
    ///     (snapshot + push) against the snapshot alone. When the merge is
    ///     more complete, the snapshot is truncated (e.g. an old engine with a
    ///     50-message cap). In that case the push buffer is the only source of
    ///     the missing content, so we DEFER the clear: issue a fresh file load
    ///     and keep the push buffer intact. The response handler
    ///     (handleAgentConversationHistory) will replace the snapshot authority
    ///     with the full data, at which point the next recomputeDispatchTranscript
    ///     call will drop the now-covered push entries naturally.
    ///
    ///   - When the snapshot is already complete (merged == snapshot count, or
    ///     no push buffer exists), clear the push cache immediately and rebuild
    ///     from the snapshot as before (push-empty fast path: merged = snapshot).
    ///
    ///   - agentSnapshotByConvId is intentionally RETAINED in both paths: it is
    ///     the file-backed authority and must survive for reopen/re-merge.
    @MainActor
    func clearTerminalDispatchCaches(for agents: [AgentStateUpdate]) {
        for agent in agents {
            for dispatch in agent.dispatches where dispatch.status == "done" || dispatch.status == "error" {
                let dispatchId = dispatch.id
                let convId = dispatch.conversationId
                guard !dispatchId.isEmpty else { continue }
                // Edge gate: only act on the first tick this dispatchAgentId goes terminal.
                guard !terminalClearedDispatches.contains(dispatchId) else {
                    DiagnosticLog.log("ENGINE: terminal dispatch already cleared (skip) dispatchId=\(dispatchId) convId=\(convId)")
                    continue
                }
                terminalClearedDispatches.insert(dispatchId)

                // Compare merged (snapshot+push) count against snapshot-only count
                // to detect a truncated snapshot before discarding push content.
                let snapshot = agentSnapshotByConvId[convId] ?? []
                let merged = agentConversationMessages[convId] ?? []
                let hasPush = agentDispatchActivity[dispatchId] != nil

                if hasPush && merged.count > snapshot.count {
                    // Snapshot is incomplete relative to what push has already shown.
                    // Issue a fresh load so the response replaces the snapshot authority
                    // with the full conversation. The push buffer is kept until the new
                    // snapshot arrives so the popup continues to show the merge rather
                    // than collapsing to the truncated snapshot-only view.
                    DiagnosticLog.log("terminal dispatch snapshot incomplete reload", tag: "session.dispatchcache", fields: [
                        "run_id": dispatchId,
                        "conversation_id": convId,
                        "count": String(snapshot.count),
                        "max": String(merged.count)
                    ])
                    // Clear the loading guard so the reload is not blocked by a stale sentinel.
                    agentConversationLoading.remove(convId)
                    refreshAgentDispatchConversation(agent: agent, conversationId: convId)
                    // Do NOT clear push or recompute here. The response handler
                    // (handleAgentConversationHistory) calls recomputeDispatchTranscript
                    // once the fresh snapshot arrives; covered push entries drop naturally.
                } else {
                    // Snapshot is complete (or no push buffer existed). Clear the push
                    // cache and rebuild from the retained snapshot.
                    if hasPush {
                        DiagnosticLog.log("clearing terminal dispatch push cache", tag: "session.dispatchcache", fields: [
                            "run_id": dispatchId,
                            "conversation_id": convId,
                            "status": String(describing: dispatch.status),
                            "count": String(snapshot.count),
                            "max": String(merged.count)
                        ])
                        agentDispatchActivity.removeValue(forKey: dispatchId)
                        agentDispatchSeqs.removeValue(forKey: dispatchId)
                    }
                    // Rebuild from the retained snapshot so the popup shows the
                    // finalized view without a new network round-trip.
                    // Pass "" dispatchAgentId so recompute takes the push-empty
                    // fast path (snapshot-only) — push cache was just cleared.
                    recomputeDispatchTranscript(dispatchAgentId: "", convId: convId)
                }
            }
        }
    }

    // MARK: - Engine session change detection (Fix A)

    /// Call this each time an `engine_status` (or `engine_session_status`)
    /// event delivers a `sessionId` for a tab. If the id is new or changed,
    /// all dispatch caches are invalidated so the next load re-fetches from
    /// the current engine binary.
    ///
    /// - Parameters:
    ///   - tabId:     The tab that emitted the status event.
    ///   - sessionId: The `StatusFields.sessionId` from the event. May be nil
    ///                or empty for non-engine tabs — those are no-ops.
    @MainActor
    func handleEngineSessionIdChange(tabId: String, sessionId: String?) {
        guard let sid = sessionId, !sid.isEmpty else { return }

        let previous = lastKnownEngineSessionId[tabId]
        // Treat "first-ever sessionId for this tab" as a session change.
        // On a fresh pairing there is no previous id, so the first engine
        // status that carries a sessionId triggers a cache clear. This is
        // correct: the caches are empty, so clearing is a no-op, but the
        // stored id is now seeded for future change detection.
        guard previous != sid else { return }

        lastKnownEngineSessionId[tabId] = sid

        // Stamp the engine session id onto subsequent DiagnosticLog lines so
        // the JSONL `session_id` correlation field is populated (schema:
        // docs/observability/log-schema.md). Omitted-when-nil is the default.
        DiagnosticLog.setSessionId(sid)

        if let previous {
            // Genuine session change: old engine → new engine. Invalidate.
            DiagnosticLog.log("engine session changed clearing caches", tag: "session.dispatchcache", fields: [
                "tab_id": String(tabId.prefix(8)),
                "reason": String(previous.prefix(20)),
                "session_id": String(sid.prefix(20))
            ])
            invalidateAllDispatchCaches()
        } else {
            // First-ever sessionId for this tab. Caches are empty; seed only.
            DiagnosticLog.log("engine session seeded", tag: "session.dispatchcache", fields: [
                "tab_id": String(tabId.prefix(8)),
                "session_id": String(sid.prefix(20))
            ])
        }
    }

    /// Wipe every dispatch cache map so the next load re-fetches from the
    /// current engine. Safe to call at any time; the popup will show
    /// "Loading…" on the next open rather than stale or empty content.
    @MainActor
    func invalidateAllDispatchCaches() {
        agentSnapshotByConvId.removeAll(keepingCapacity: false)
        agentConversationMessages.removeAll(keepingCapacity: false)
        agentDispatchActivity.removeAll(keepingCapacity: false)
        agentDispatchSeqs.removeAll(keepingCapacity: false)
        terminalClearedDispatches.removeAll(keepingCapacity: false)
        agentConversationLoading.removeAll(keepingCapacity: false)
        activeDispatchIdByConvId.removeAll(keepingCapacity: false)
        DiagnosticLog.log("DISPATCH-CACHE: all dispatch caches cleared")
    }
}
