import Foundation

// MARK: - Dispatch telemetry child accessor
//
// Given a dispatchId, returns the child telemetry entries whose
// dispatchParentId matches. Used by AgentDetailFullScreenView to
// render recursive agent trees. Keyed by dispatchId, never name.

extension SessionViewModel {

    /// Child telemetry entries for a given parent dispatchId on a tab.
    /// Each returned entry carries its own depth + conversationId. This reads
    /// the LIVE one-shot `dispatchTelemetry` stream; it is no longer the
    /// dispatch-preview's child source (that moved to `childAgentStates`, which
    /// survives heartbeat replay) but remains a valid accessor over live
    /// telemetry for callers that have it.
    @MainActor
    func childDispatchTelemetry(tabId: String, parentDispatchId: String) -> [DispatchTelemetryEntry] {
        let instanceId = activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
        guard let inst = engineInstance(tabId: tabId, instanceId: instanceId) else { return [] }
        let telemetry = inst.dispatchTelemetry ?? []
        return telemetry.filter { $0.dispatchParentId == parentDispatchId }
    }

    /// Child AGENT-STATE pills for a given parent dispatchId on a tab: every
    /// agent-state pill whose `dispatchParentId` equals `parentDispatchId`.
    ///
    /// This is the DURABLE child source. Agent-state pills carry the same
    /// nesting attribution (`dispatchParentId`, `dispatches`) and are
    /// re-emitted on every `engine_agent_state` heartbeat snapshot, so a child
    /// renders even when the one-shot `dispatchTelemetry` was missed (late
    /// attach / tab reopen). The dispatch-preview drives its nested child rows
    /// from here instead of `childDispatchTelemetry`, mirroring the desktop's
    /// `childAgentsOf`. An empty `parentDispatchId` matches nothing.
    @MainActor
    func childAgentStates(tabId: String, parentDispatchId: String) -> [AgentStateUpdate] {
        guard !parentDispatchId.isEmpty else { return [] }
        let instanceId = activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
        guard let inst = engineInstance(tabId: tabId, instanceId: instanceId) else { return [] }
        return inst.agentStates.filter { $0.dispatchParentId == parentDispatchId }
    }
}
