import SwiftUI

/// Resolved appearance for one status dot, plus its rank so an aggregate over
/// several dispatches can pick the most important state to show.
///
/// Swift port of the desktop `RankedStatusDot` (renderer/lib/agent-helpers.ts).
/// Keep the cascade and the ranks in sync with that file: the two clients must
/// agree on what an agent row means.
struct AgentDot: Equatable {
    let color: Color
    let pulses: Bool
    let glows: Bool
    /// Higher wins when folding several dispatches into one dot.
    let priority: Int
}

/// How one agent row's status indicator should render: a single dot when there
/// is nothing to split, or two overlapping dots when the most recent dispatch
/// and the earlier ones can disagree.
///
/// Mirrors the desktop `AgentDotModel` (renderer/lib/agent-dot-model.ts).
enum AgentDotModel: Equatable {
    case single(AgentDot)
    case stack(foreground: AgentDot, background: AgentDot)
}

enum AgentDotResolver {

    /// Statuses that mean "this agent is alive", as opposed to terminal.
    ///
    /// `suspended` is the engine's park state (dispatch_agent.go sets it when a
    /// dispatch waits on its children or a revive). A parked agent has NOT
    /// finished, so every liveness question here treats it like `running`.
    static func isLiveStatus(_ status: String) -> Bool {
        status == "running" || status == "suspended"
    }

    /// Resolve the dot for one status, given whether a live descendant hangs
    /// off the dispatch being described.
    ///
    ///   error                          → statusError, solid
    ///   live descendant, or suspended  → statusWaitingChildren, pulsing + glow
    ///   running                        → statusRunning, pulsing
    ///   done                           → statusDone, solid
    ///   else (idle / cancelled / …)    → muted, solid
    ///
    /// The descendant check sits ABOVE the terminal branches deliberately: a
    /// parent marked done while a child still runs must read as waiting-on-
    /// children, never as a finished dot, because the tree is not finished.
    static func resolveDot(
        status: String,
        hasLiveDescendant: Bool,
        theme: AppTheme
    ) -> AgentDot {
        if status == "error" {
            return AgentDot(color: theme.statusError, pulses: false, glows: false, priority: 4)
        }
        if hasLiveDescendant || status == "suspended" {
            return AgentDot(color: theme.statusWaitingChildren, pulses: true, glows: true, priority: 3)
        }
        if status == "running" {
            return AgentDot(color: theme.statusRunning, pulses: true, glows: false, priority: 2)
        }
        if status == "done" {
            return AgentDot(color: theme.statusDone, pulses: false, glows: false, priority: 1)
        }
        return AgentDot(color: theme.textSecondary.opacity(0.5), pulses: false, glows: false, priority: 0)
    }

    /// Whether any agent anywhere BELOW the given dispatch is still alive.
    ///
    /// Breadth-first over the dispatch tree: children of `dispatchId` are the
    /// agents whose `dispatchParentId` names it, and each of those agents' own
    /// dispatch ids are queued in turn, so a depth-3+ descendant counts just as
    /// a direct child does. Matching on the dispatch ID (not the agent name) is
    /// what makes this precise — a grouped agent row spans several dispatches,
    /// and only the id says which one owns a given descendant. `visited` guards
    /// against a cycle in malformed parent attribution.
    static func hasLiveDescendant(
        ofDispatch dispatchId: String,
        in agents: [AgentStateUpdate]
    ) -> Bool {
        guard !dispatchId.isEmpty else { return false }
        var queue = [dispatchId]
        var visited = Set<String>()
        while let current = queue.first {
            queue.removeFirst()
            if current.isEmpty || visited.contains(current) { continue }
            visited.insert(current)
            for child in agents where child.dispatchParentId == current {
                if isLiveStatus(child.status) { return true }
                queue.append(contentsOf: child.dispatches.map(\.id))
            }
        }
        return false
    }

    /// The agent's most recent dispatch, by START TIME rather than array order.
    ///
    /// The engine merges dispatches in slot-insertion order and de-duplicates
    /// them by id, so the array is only incidentally chronological — trusting
    /// `.last` would silently pick the wrong one after a persist/rehydrate
    /// round-trip. Members with no `startTime` fall back to array position.
    static func mostRecentDispatch(_ dispatches: [DispatchInfo]) -> DispatchInfo? {
        guard var best = dispatches.first else { return nil }
        var bestIdx = 0
        for (i, candidate) in dispatches.enumerated().dropFirst() {
            let candidateTime = candidate.startTime
            let bestTime = best.startTime
            if candidateTime == nil && bestTime == nil {
                best = candidate
                bestIdx = i
                continue
            }
            guard let ct = candidateTime else { continue }
            if bestTime == nil || ct > bestTime! || (ct == bestTime! && i > bestIdx) {
                best = candidate
                bestIdx = i
            }
        }
        return best
    }

    /// Resolve a detail subject. A pager/deep link may explicitly name an older
    /// dispatch; otherwise default to the same start-time-most-recent dispatch
    /// used by the row's foreground dot and duration.
    static func detailSubject(_ dispatches: [DispatchInfo], dispatchId: String) -> DispatchInfo? {
        if !dispatchId.isEmpty,
           let selected = dispatches.first(where: { $0.id == dispatchId }) {
            return selected
        }
        return mostRecentDispatch(dispatches)
    }

    /// Whether an agent counts as ACTIVE for the panel header's breakdown.
    ///
    /// True when the agent itself is live, or when any of its dispatches still
    /// owns a live descendant. The second clause keeps the header honest with
    /// the row dots: a lead whose own dispatches all finished, but one of whose
    /// older dispatches still has a specialist working, is not "done".
    static func isActive(_ agent: AgentStateUpdate, in agents: [AgentStateUpdate]) -> Bool {
        if isLiveStatus(agent.status) { return true }
        return agent.dispatches.contains { hasLiveDescendant(ofDispatch: $0.id, in: agents) }
    }

    /// Resolve the dot(s) for one agent row.
    ///
    /// ── Why two dots ────────────────────────────────────────────────────────
    ///
    /// An agent row can own several dispatches, and folding them into ONE dot
    /// destroys the distinction the operator needs. A lead whose most recent
    /// dispatch finished while an OLD dispatch still owns a running specialist
    /// renders, under a single aggregated dot, as plain "active" —
    /// indistinguishable from the lead itself working, so a stalled specialist
    /// goes unnoticed.
    ///
    ///   • FOREGROUND — always the most recent dispatch. Fixed meaning; this
    ///     function accepts no selected index, so navigating inside the detail
    ///     view can never repoint what the row reports.
    ///   • BACKGROUND — always the aggregate of the PREVIOUS dispatches, never
    ///     the most recent. That exclusion is what preserves the contrast.
    ///
    /// Fewer than two dispatches collapses to a single dot; with two or more the
    /// background always renders (green when history is clean), so its absence
    /// means "no history", never "history we declined to show".
    static func resolve(
        agent: AgentStateUpdate,
        allAgents: [AgentStateUpdate],
        theme: AppTheme
    ) -> AgentDotModel {
        let dispatches = agent.dispatches
        if dispatches.isEmpty {
            return .single(resolveDot(status: agent.status, hasLiveDescendant: false, theme: theme))
        }

        let recent = mostRecentDispatch(dispatches)
        let foreground = dot(for: recent, agent: agent, allAgents: allAgents, theme: theme)

        let previous = dispatches.filter { $0.id != recent?.id }
        guard let first = previous.first else { return .single(foreground) }

        var background = dot(for: first, agent: agent, allAgents: allAgents, theme: theme)
        for d in previous.dropFirst() {
            let candidate = dot(for: d, agent: agent, allAgents: allAgents, theme: theme)
            if candidate.priority > background.priority { background = candidate }
        }
        return .stack(foreground: foreground, background: background)
    }

    /// Dot for a single dispatch. A member with no status of its own (freshly
    /// minted, or a legacy row) falls back to the agent's status.
    private static func dot(
        for dispatch: DispatchInfo?,
        agent: AgentStateUpdate,
        allAgents: [AgentStateUpdate],
        theme: AppTheme
    ) -> AgentDot {
        let dispatchStatus = dispatch?.status ?? ""
        let status = dispatchStatus.isEmpty ? agent.status : dispatchStatus
        let live = dispatch.map { hasLiveDescendant(ofDispatch: $0.id, in: allAgents) } ?? false
        return resolveDot(status: status, hasLiveDescendant: live, theme: theme)
    }
}
