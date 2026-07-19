import Foundation

// MARK: - SessionStatus dispatcher (Phase 3 of state-management overhaul)
//
// Single chokepoint for applying the engine's new engine_session_status
// event onto the iOS-side per-instance cache. Today (Phase 3) this
// dispatcher coexists with the legacy `engine_status` writer in
// SessionViewModel+EventHandlers.swift; Phase 4 deletes the legacy
// writer and promotes this method to the only path that mutates
// engine-instance status state.
//
// The motivation for the dispatcher pattern is documented in the
// state-management overhaul plan. Briefly: iOS today has ~5 separate
// writers of `tab.status` (text-delta inference, error inference,
// snapshot reset, tabStatus event, command-submit synthesis), and the
// engine's authoritative answer is one of many voices in that chorus.
// Phase 4 will route every writer through this single dispatcher so
// the engine's typed payload is the sole source of truth.

extension SessionViewModel {

    /// Apply an engine_session_status payload onto the per-instance
    /// cache and the parent tab's status field. Phase 3 contract:
    ///
    ///   - Synthesizes a legacy `StatusFields` from the new payload
    ///     and writes it to `conversationInstances[i].statusFields`. This
    ///     keeps every existing consumer (status caption, instance bar,
    ///     model-fallback indicator) reading from the same field so no
    ///     UI surface needs awareness of which event drove the update.
    ///
    ///   - Does NOT touch `tab.status` directly in Phase 3 — the legacy
    ///     `engine_status` path continues to drive that field via
    ///     `mutateEngineInstance` plus the snapshot derivation in
    ///     `desktop/src/main/remote/snapshot.ts`. Phase 4 promotes
    ///     SessionStatus.state to the authoritative tab status.
    ///
    /// The function is idempotent: applying the same SessionStatus
    /// twice is a no-op because the receiving fields hold the same
    /// values after each call.
    @MainActor
    func applyEngineSessionStatus(
        tabId: String,
        instanceId: String?,
        status: SessionStatus
    ) {
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            // RC-23: MERGE, do not wholesale-replace. numTurns / conversationTurns
            // have no SessionStatus source (they are stamped from TaskCompleteEvent
            // via the legacy engine_status path). A full replace with nils clobbered
            // them whenever engine_session_status landed after engine_status, so the
            // status-bar turn count flickered to nil until the next engine_status
            // restamped it. Carry the existing counts through the synthesis.
            let synthesized = SessionStatusSynthesis.toStatusFields(
                tabId: tabId,
                status: status,
                priorNumTurns: inst.statusFields?.numTurns,
                priorConversationTurns: inst.statusFields?.conversationTurns
            )
            inst.statusFields = synthesized
        }
    }
}

/// Pure helpers for SessionStatus → StatusFields synthesis. Extracted
/// from the dispatcher method so the synthesis can be unit-tested
/// without constructing a SessionViewModel. The dispatcher itself is
/// trivial — it delegates to this helper and writes the result via
/// mutateEngineInstance.
///
/// Phase 4 will introduce a parallel
/// `SessionStatusSynthesis.toRemoteTabStatus` that promotes
/// SessionStatus.state to the authoritative `tab.status` value once
/// the legacy writers are removed.
enum SessionStatusSynthesis {
    /// Synthesize a legacy `StatusFields` from a Phase 3 SessionStatus
    /// payload. Used by the dispatcher to keep every existing read
    /// site working unchanged during the transition window.
    ///
    /// Field mapping:
    ///   - state → state (verbatim)
    ///   - sessionId → sessionId
    ///   - model → model (empty string when nil — StatusFields.model
    ///     is non-optional)
    ///   - contextPercent → contextPercent (cast Int → Double)
    ///   - contextWindow → contextWindow (0 when nil)
    ///   - runCostUsd → runCostUsd (preserve nil)
    ///   - conversationCostUsd → conversationCostUsd (preserve nil)
    ///   - permissionDenialsPending → permissionDenials
    ///   - extensionName → extensionName
    ///   - backgroundAgentCount → backgroundAgents
    ///
    /// Fields unique to SessionStatus (lastEmittedAt, hasInflightRun,
    /// stateSince) have no analogue in StatusFields and are dropped at
    /// this seam. Phase 4 introduces an iOS-side store for them.
    ///
    /// Conversely, StatusFields.numTurns and StatusFields.conversationTurns
    /// have no SessionStatus source (both counts are stamped from
    /// TaskCompleteEvent, not carried on SessionStatus). RC-23: they are
    /// PRESERVED from the prior StatusFields (passed in by the dispatcher)
    /// rather than nil-clobbered, so an engine_session_status landing after an
    /// engine_status does not blank the turn count.
    static func toStatusFields(
        tabId: String,
        status: SessionStatus,
        priorNumTurns: Int? = nil,
        priorConversationTurns: Int? = nil
    ) -> StatusFields {
        return StatusFields(
            label: tabId,
            state: status.state,
            sessionId: status.sessionId,
            team: nil,
            model: status.model ?? "",
            contextPercent: Double(status.contextPercent ?? 0),
            contextWindow: status.contextWindow ?? 0,
            runCostUsd: status.runCostUsd,
            conversationCostUsd: status.conversationCostUsd,
            permissionDenials: status.permissionDenialsPending,
            extensionName: status.extensionName,
            backgroundAgents: status.backgroundAgentCount,
            numTurns: priorNumTurns,
            conversationTurns: priorConversationTurns
        )
    }
}
