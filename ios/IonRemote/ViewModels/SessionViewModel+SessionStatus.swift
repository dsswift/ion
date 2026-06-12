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
    ///     and writes it to `engineInstances[i].statusFields`. This
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
        let synthesized = SessionStatusSynthesis.toStatusFields(tabId: tabId, status: status)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) {
            $0.statusFields = synthesized
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
    ///   - totalCostUsd → totalCostUsd (preserve nil)
    ///   - permissionDenialsPending → permissionDenials
    ///   - extensionName → extensionName
    ///   - backgroundAgentCount → backgroundAgents
    ///
    /// Fields unique to SessionStatus (lastEmittedAt, hasInflightRun,
    /// stateSince) have no analogue in StatusFields and are dropped at
    /// this seam. Phase 4 introduces an iOS-side store for them.
    static func toStatusFields(tabId: String, status: SessionStatus) -> StatusFields {
        return StatusFields(
            label: tabId,
            state: status.state,
            sessionId: status.sessionId,
            team: nil,
            model: status.model ?? "",
            contextPercent: Double(status.contextPercent ?? 0),
            contextWindow: status.contextWindow ?? 0,
            totalCostUsd: status.totalCostUsd,
            permissionDenials: status.permissionDenialsPending,
            extensionName: status.extensionName,
            backgroundAgents: status.backgroundAgentCount
        )
    }
}
