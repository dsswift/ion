import Foundation

extension SessionViewModel {
    /// Append the scrollback notice for a dispatch the engine lost to a restart.
    ///
    /// The agent list already shows the row errored from the rehydrated
    /// snapshot, but a conversation that was waiting on this agent otherwise
    /// just goes quiet — the operator sees a turn that ended and no reason why.
    ///
    /// Mirrors the desktop's `formatDispatchLostDivider`; the two are pinned
    /// identical by `DispatchLostWireTests` and `clear-divider.test.ts`. Keep
    /// the wording in step when either side changes.
    @MainActor
    func handleEngineDispatchLost(tabId: String, instanceId: String?, agentName: String) {
        let time = Date()
        let msg = Message(
            id: UUID().uuidString,
            role: .system,
            content: Self.dispatchLostDividerText(at: time, agentName: agentName),
            timestamp: time.timeIntervalSince1970 * 1000
        )
        // The announcement arrives during rehydration, before any run is live,
        // so this is a settled-history row rather than a live-tail one.
        appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)
    }

    /// The divider text itself, separated so the parity test can assert it
    /// without driving a view model.
    static func dispatchLostDividerText(at time: Date, agentName: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let who = agentName.isEmpty ? "agent" : agentName
        return "── \(who) was lost when the engine restarted at \(formatter.string(from: time)) ──"
    }
}
