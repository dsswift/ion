import Foundation

/// Pure dispatch-ID selection for AgentBarRow stop controls.
///
/// Agent names are not identities: several concurrent dispatches can share one
/// name and are grouped into one row. Stop actions therefore resolve from each
/// dispatch member's collision-safe ID. Per-dispatch status wins; a legacy
/// member with an empty status falls back to the representative row status.
enum AgentDispatchStopResolver {
    /// Every unique running dispatch ID represented by this row, in display
    /// order. Empty/malformed IDs are excluded because they address nothing.
    static func runningDispatchIds(
        dispatches: [DispatchInfo],
        agentStatus: String
    ) -> [String] {
        var seen = Set<String>()
        return dispatches.compactMap { dispatch in
            let status = dispatch.status.isEmpty ? agentStatus : dispatch.status
            guard status == "running",
                  !dispatch.id.isEmpty,
                  seen.insert(dispatch.id).inserted else { return nil }
            return dispatch.id
        }
    }

    /// Primary Stop targets the latest running dispatch, matching the row's
    /// default pager selection. nil means this row has no stoppable instance.
    static func primaryDispatchId(
        dispatches: [DispatchInfo],
        agentStatus: String
    ) -> String? {
        runningDispatchIds(dispatches: dispatches, agentStatus: agentStatus).last
    }
}
