import Foundation

// SessionViewModel+AgentStateEvent.swift — handling for engine_agent_state.
//
// Split out of SessionViewModel+EventHandlers.swift, which reached its
// 600-line cap. The seam is a real one rather than an arbitrary cut: this case
// is the only one that both replaces a whole collection and can request a
// follow-up round-trip, so it carries logic the other cases do not.

extension SessionViewModel {
    /// Apply an `engine_agent_state` payload.
    ///
    /// Engine contract: this event is a complete snapshot of every agent the
    /// engine considers live. Replace local state with the payload, full stop
    /// — no merging, no historical preservation. See
    /// docs/architecture/agent-state.md.
    ///
    /// Post-#256 a tab has exactly one conversation instance, so the event's
    /// instanceId is vestigial; mutateEngineInstance targets that single
    /// instance regardless.
    @MainActor
    func applyAgentStateEvent(
        tabId: String,
        instanceId: String?,
        agents: [AgentStateUpdate],
        metadataOmitted: Bool
    ) {
        let statuses = agents.map { "\($0.name):\($0.status)" }.joined(separator: ",")
        DiagnosticLog.log("agent state", tag: "session.events", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(agents.count),
            "agent": statuses
        ])
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.agentStates = agents }

        // Clear push/snapshot input caches for terminal dispatches so stale
        // push entries don't produce ghost duplicates on popup reopen.
        clearTerminalDispatchCaches(for: agents)

        // A degraded roster carries agent identity but not detail: the desktop
        // shed metadata to fit a transport size cap. Ask for a full one rather
        // than rendering blank task/lastWork fields as though the agents
        // genuinely had none.
        //
        // The desktop also self-heals on its own timer, so this is
        // belt-and-braces — it matters for the case where the transient
        // overflow has already cleared and a fresh roster would now fit.
        if metadataOmitted {
            DiagnosticLog.log("agent state degraded, requesting full roster",
                              tag: "session.events", level: .warn,
                              fields: ["tab_id": String(tabId.prefix(8))])
            send(.requestAgentState(tabId: tabId, instanceId: instanceId))
        }
    }
}
