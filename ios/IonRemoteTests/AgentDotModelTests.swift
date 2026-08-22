import XCTest
import SwiftUI
@testable import IonRemote

/// Behavioral pins for the agent row's two-dot status model — the Swift mirror
/// of `desktop/src/renderer/lib/__tests__/agent-dot-model.test.ts`. Keep the two
/// case matrices in sync: the clients must agree on what an agent row means.
///
/// THE BUG THIS EXISTS FOR: a lead agent whose most recent dispatch finished
/// while an OLDER dispatch still owned a running specialist rendered as a
/// single solid green dot, and the header read "done" with no active segment.
/// The live specialist — which may have stalled — was invisible.
///
/// The "reported case" and "inverse case" tests are a PAIR: either alone would
/// still pass if the model folded every dispatch into one lumped dot, and only
/// together do they pin that the two subjects stay distinct.
final class AgentDotModelTests: XCTestCase {

    private let theme: AppTheme = IonDarkTheme()

    // MARK: - Fixtures

    private func makeAgent(
        name: String,
        status: String,
        dispatches: [[String: Any]] = [],
        parentDispatchId: String? = nil
    ) -> AgentStateUpdate {
        var metadata: [String: Any] = [
            "displayName": name,
            "type": "specialist",
            "visibility": "always",
            "invited": true,
            "dispatches": dispatches,
        ]
        if let parentDispatchId {
            metadata["dispatchParentId"] = parentDispatchId
            metadata["dispatchDepth"] = 2
        }
        let raw: [String: Any] = [
            "id": "agent-\(name)",
            "name": name,
            "status": status,
            "metadata": metadata,
        ]
        let data = try! JSONSerialization.data(withJSONObject: raw)
        return try! JSONDecoder().decode(AgentStateUpdate.self, from: data)
    }

    private func dispatch(
        _ id: String,
        _ status: String,
        startTime: Double? = nil,
        waitingOn: String? = nil
    ) -> [String: Any] {
        var d: [String: Any] = ["id": id, "task": "t", "model": "m", "conversationId": "", "status": status]
        if let startTime { d["startTime"] = startTime }
        if let waitingOn { d["waitingOn"] = waitingOn }
        return d
    }

    // MARK: - Collapse rule

    func test_noDispatches_rendersSingleDot() {
        let roster = makeAgent(name: "solo", status: "idle")
        guard case .single = AgentDotResolver.resolve(agent: roster, allAgents: [roster], theme: theme) else {
            return XCTFail("expected a single dot for an agent with no dispatches")
        }
    }

    func test_singleDispatch_rendersSingleDot() {
        let agent = makeAgent(name: "lead", status: "running",
                              dispatches: [dispatch("d1", "running", startTime: 100)])
        guard case .single = AgentDotResolver.resolve(agent: agent, allAgents: [agent], theme: theme) else {
            return XCTFail("expected a single dot for one dispatch")
        }
    }

    func test_twoDispatches_rendersStack() {
        let agent = makeAgent(name: "lead", status: "done", dispatches: [
            dispatch("d1", "done", startTime: 100),
            dispatch("d2", "done", startTime: 200),
        ])
        guard case .stack = AgentDotResolver.resolve(agent: agent, allAgents: [agent], theme: theme) else {
            return XCTFail("expected a stack for two dispatches")
        }
    }

    // MARK: - Most-recent vs. older split

    /// THE REPORTED CASE: recent dispatch finished, older one still owns a live
    /// depth-2 descendant. Foreground green, background pulsing yellow.
    func test_recentDone_olderWithLiveDescendant_greenOverPulsingYellow() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        let spec = makeAgent(name: "code-engineer", status: "running", parentDispatchId: "d-old")

        guard case let .stack(foreground, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead, spec], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(foreground.color, theme.statusDone, "foreground follows the finished recent dispatch")
        XCTAssertFalse(foreground.pulses)
        XCTAssertEqual(background.color, theme.statusWaitingChildren, "older dispatch still owns a live agent")
        XCTAssertTrue(background.pulses)
    }

    /// THE INVERSE: recent dispatch actively running, history clean. Pairs with
    /// the test above — a lumped single-dot model cannot satisfy both.
    func test_recentRunning_olderAllDone_orangeOverGreen() {
        let lead = makeAgent(name: "dev-lead", status: "running", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "running", startTime: 200),
        ])
        guard case let .stack(foreground, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(foreground.color, theme.statusRunning)
        XCTAssertTrue(foreground.pulses)
        XCTAssertEqual(background.color, theme.statusDone)
        XCTAssertFalse(background.pulses)
    }

    func test_backgroundNeverReflectsTheMostRecentDispatch() {
        // Most recent errored; every earlier dispatch finished cleanly. A
        // background that folded in the most recent would go red.
        let lead = makeAgent(name: "dev-lead", status: "error", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "error", startTime: 200),
        ])
        guard case let .stack(foreground, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(foreground.color, theme.statusError)
        XCTAssertEqual(background.color, theme.statusDone)
    }

    // MARK: - Per-dispatch resolver

    func test_perDispatchResolver_preservesDispatchLivenessAndPulse() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        let specialist = makeAgent(name: "code-engineer", status: "running", parentDispatchId: "d-old")

        let oldDot = AgentDotResolver.resolveDispatchDot(
            agent: lead,
            dispatch: lead.dispatches.first { $0.id == "d-old" },
            allAgents: [lead, specialist],
            theme: theme
        )
        let recentDot = AgentDotResolver.resolveDispatchDot(
            agent: lead,
            dispatch: lead.dispatches.first { $0.id == "d-recent" },
            allAgents: [lead, specialist],
            theme: theme
        )

        XCTAssertEqual(oldDot.color, theme.statusWaitingChildren)
        XCTAssertTrue(oldDot.pulses)
        XCTAssertTrue(oldDot.glows)
        XCTAssertEqual(recentDot.color, theme.statusDone)
        XCTAssertFalse(recentDot.pulses)
    }

    // MARK: - Most-recent resolution

    func test_mostRecentResolvedByStartTime_notArrayPosition() {
        // The chronologically-recent dispatch sits FIRST in the array: the
        // engine merges in slot-insertion order, so position is not chronology.
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-late", "running", startTime: 900),
            dispatch("d-early", "done", startTime: 100),
        ])
        guard case let .stack(foreground, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(foreground.color, theme.statusRunning, "foreground must follow d-late, not the last slot")
        XCTAssertEqual(background.color, theme.statusDone)
    }

    func test_noStartTimes_fallsBackToArrayPosition() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d1", "done"),
            dispatch("d2", "running"),
        ])
        guard case let .stack(foreground, _) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(foreground.color, theme.statusRunning)
    }

    func test_detailSubject_prefersExplicitDispatchOtherwiseUsesMostRecent() {
        let dispatches = [
            DispatchInfo(id: "d-late", task: "late", model: "m", conversationId: "conv-late", elapsed: nil, status: "done", startTime: 900),
            DispatchInfo(id: "d-early", task: "early", model: "m", conversationId: "conv-early", elapsed: nil, status: "done", startTime: 100),
        ]

        XCTAssertEqual(
            AgentDotResolver.detailSubject(dispatches, dispatchId: "")?.conversationId,
            "conv-late",
            "default detail subject must match foreground dot's start-time-most-recent dispatch"
        )
        XCTAssertEqual(
            AgentDotResolver.detailSubject(dispatches, dispatchId: "d-early")?.conversationId,
            "conv-early",
            "pager/deep-link selection must keep its explicit older dispatch"
        )
    }

    // MARK: - Descendant walk

    func test_suspendedDescendantCountsAsLive() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        let parked = makeAgent(name: "spec", status: "suspended", parentDispatchId: "d-old")
        guard case let .stack(_, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead, parked], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(background.color, theme.statusWaitingChildren,
                       "a parked dispatch is alive, not finished")
    }

    func test_depthThreeDescendantIsDetected() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        // d-old → mid (done, owns d-mid) → deep (running). Only a recursive
        // walk reaches `deep`; direct-children matching reports all-clear.
        let mid = makeAgent(name: "mid", status: "done",
                            dispatches: [dispatch("d-mid", "done")], parentDispatchId: "d-old")
        let deep = makeAgent(name: "deep", status: "running", parentDispatchId: "d-mid")
        guard case let .stack(_, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead, mid, deep], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(background.color, theme.statusWaitingChildren)
    }

    func test_terminalDescendantsLeaveBackgroundGreen() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        let finished = makeAgent(name: "spec", status: "done", parentDispatchId: "d-old")
        guard case let .stack(_, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead, finished], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(background.color, theme.statusDone)
    }

    func test_cycleInParentAttributionTerminates() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        // a → b → a: malformed attribution must not spin forever.
        let a = makeAgent(name: "a", status: "done",
                          dispatches: [dispatch("d-a", "done")], parentDispatchId: "d-old")
        let b = makeAgent(name: "b", status: "done",
                          dispatches: [dispatch("d-old", "done")], parentDispatchId: "d-a")
        guard case let .stack(_, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead, a, b], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(background.color, theme.statusDone)
    }

    func test_errorOutranksWaitingDescendantInBackgroundFold() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-error", "error", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        let runningChild = makeAgent(name: "spec", status: "running", parentDispatchId: "d-error")

        guard case let .stack(_, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: [lead, runningChild], theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(background.color, theme.statusError,
                       "terminal error must outrank waiting descendant in the historical fold")
        XCTAssertFalse(background.pulses)
    }

    // MARK: - Shell wait tier

    func test_dispatchInfo_roundTripsWaitingOn() throws {
        let encoded = """
        {"id":"shell","task":"t","model":"m","conversationId":"c","status":"suspended","waitingOn":"shell"}
        """.data(using: .utf8)!
        let dispatch = try JSONDecoder().decode(DispatchInfo.self, from: encoded)
        XCTAssertEqual(dispatch.waitingOn, "shell")

        let roundTrip = try JSONEncoder().encode(dispatch)
        let decoded = try JSONDecoder().decode(DispatchInfo.self, from: roundTrip)
        XCTAssertEqual(decoded.waitingOn, "shell")
    }

    func test_shellWait_rendersPulsingBashDot() {
        let agent = makeAgent(name: "shell-worker", status: "suspended", dispatches: [
            dispatch("d-shell", "suspended", startTime: 100, waitingOn: "shell"),
        ])
        guard case let .single(dot) = AgentDotResolver.resolve(agent: agent, allAgents: [agent], theme: theme) else {
            return XCTFail("expected a single dot")
        }
        XCTAssertEqual(dot.color, theme.statusBash)
        XCTAssertTrue(dot.pulses)
        XCTAssertFalse(dot.glows)
    }

    func test_sort_placesChildWaitBeforeShellWaitBeforeRunning() {
        let childWait = makeAgent(name: "children", status: "done", dispatches: [
            dispatch("d-children", "done", startTime: 100),
        ])
        let child = makeAgent(name: "child", status: "running", parentDispatchId: "d-children")
        let shellWait = makeAgent(name: "shell", status: "suspended", dispatches: [
            dispatch("d-shell", "suspended", startTime: 100, waitingOn: "shell"),
        ])
        let running = makeAgent(name: "running", status: "running", dispatches: [
            dispatch("d-running", "running", startTime: 100),
        ])
        let all = [running, shellWait, childWait, child]

        XCTAssertEqual(
            AgentDotResolver.sortedAgents([running, shellWait, childWait], allAgents: all).map(\.name),
            ["children", "shell", "running"]
        )
    }

    // MARK: - Header breakdown parity

    /// The header must agree with the dots: a lead whose own dispatches are all
    /// finished but which still owns a live descendant counts as ACTIVE, not
    /// done. Reading the bare status is the defect the row's background dot
    /// fixes, so the two surfaces must not disagree.
    func test_headerBreakdown_countsDescendantWaitingLeadAsActive() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        let spec = makeAgent(name: "code-engineer", status: "running", parentDispatchId: "d-old")
        let all = [lead, spec]

        let counts = [lead].agentHeaderBreakdown(in: all)
        XCTAssertEqual(counts.active, 1, "the lead is waiting on a live descendant")
        XCTAssertEqual(counts.done, 0, "and so must not be counted as finished")
    }

    // MARK: - Visible vs unfiltered list split

    /// Regression: the visible root lead must resolve as active when the
    /// running descendant is in the full (unfiltered) list but NOT in the
    /// visible (root-only) list. Before the fix, TranscriptAgentSection
    /// passed only the visible set to both isActive and AgentBarRow, so the
    /// descendant walk found nothing and the lead read as done.
    func test_visibleLeadActiveThroughUnfilteredDescendant() {
        let lead = makeAgent(name: "dev-lead", status: "done", dispatches: [
            dispatch("d-old", "done", startTime: 100),
            dispatch("d-recent", "done", startTime: 200),
        ])
        let spec = makeAgent(name: "code-engineer", status: "running", parentDispatchId: "d-old")

        let visible = [lead]
        let all = [lead, spec]

        // isActive against the visible-only set misses the descendant
        let activeWithVisibleOnly = visible.filter { AgentDotResolver.isActive($0, in: visible) }.count
        XCTAssertEqual(activeWithVisibleOnly, 0, "visible-only list cannot see the descendant")

        // isActive against the full unfiltered set finds it
        let activeWithAll = visible.filter { AgentDotResolver.isActive($0, in: all) }.count
        XCTAssertEqual(activeWithAll, 1, "unfiltered list exposes the live descendant")

        // Exercise the actual TranscriptAgentSection computation, not merely
        // the shared resolver: reverting its allAgents wiring makes this red.
        let section = TranscriptAgentSection(
            agents: visible,
            allAgents: all,
            onOpenDispatch: nil,
            title: "Agents",
            tabId: nil,
            isExpanded: .constant(true),
            isFullscreen: .constant(false)
        )
        XCTAssertEqual(section.runningCount, 1,
                       "primary transcript header must count the visible lead as active")
        XCTAssertEqual(section.dispatchCount, lead.dispatches.count,
                       "primary transcript header must expose persisted dispatch history count")

        // The dot model must also reflect the descendant via the full list
        guard case let .stack(_, background) =
            AgentDotResolver.resolve(agent: lead, allAgents: all, theme: theme) else {
            return XCTFail("expected a stack")
        }
        XCTAssertEqual(background.color, theme.statusWaitingChildren,
                       "dot must show waiting-children when unfiltered list carries the descendant")
    }
}
