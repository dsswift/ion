import XCTest
import SwiftUI
@testable import IonRemote

/// Pins the `TabRowView.statusInfo` priority order for the running-children
/// vs. plan-ready conflict.
///
/// Desktop fix b8e21298 made `hasRunningChildren` (yellow pulse) outrank
/// `planReady` (green) in the tab-strip priority cascade. iOS already had the
/// correct order in `TabRowView.statusInfo` (hasRunningChildren checked at
/// step 5, planReady at step 6), but had no test locking it against future
/// regression.
///
/// This test pins:
///   1. When BOTH `hasRunningChildren == true` AND an ExitPlanMode entry is
///      in the permissionQueue, statusInfo resolves to yellow + pulse (the
///      running-children state), NOT green (plan-ready).
///   2. plan-ready alone (no running children) still resolves green — so the
///      test is not trivially passing because plan-ready is broken.
///   3. running-children alone (no plan-ready) resolves yellow + pulse.
///   4. Neither flag set resolves gray (default) — sanity anchor.
///
/// Desktop↔iOS parity: this is the iOS counterpart of the desktop
/// `hasRunningChildren` > `planReady` ordering in TabStripTabPill. Both
/// clients must agree. See AGENTS.md § "Common parity surfaces".
final class TabRowStatusPriorityTests: XCTestCase {

    // MARK: - Helpers

    private let yellowHex: UInt = 0xF59E0B  // statusWaitingChildren
    private let greenColor = Color.green

    /// Build a minimal RemoteTabState with the fields the test varies.
    private func makeTab(
        status: TabStatus = .idle,
        hasRunningChildren: Bool? = nil,
        permissionQueue: [PermissionRequest] = []
    ) -> RemoteTabState {
        RemoteTabState(
            id: "tab-parity-test",
            title: "Parity Test",
            customTitle: nil,
            status: status,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: permissionQueue,
            hasRunningChildren: hasRunningChildren
        )
    }

    /// A PermissionRequest that represents a plan-ready (ExitPlanMode) denial.
    private func planReadyEntry() -> PermissionRequest {
        PermissionRequest(
            questionId: "qid-exitplan",
            toolName: "ExitPlanMode",
            toolInput: nil,
            options: []
        )
    }

    /// Construct a TabRowView for the given tab and read its statusInfo.
    /// TabRowView is a pure value-type View; instantiating it does not require
    /// a host or rendering context — statusInfo is a computed property on the
    /// struct itself, not a rendering artifact.
    private func statusInfo(for tab: RemoteTabState) -> (color: Color, pulse: Bool) {
        TabRowView(tab: tab).statusInfo
    }

    // MARK: - Core parity test

    /// Both flags set: running-children MUST outrank plan-ready.
    ///
    /// This is the regression gate for the desktop fix b8e21298 and for any
    /// future iOS refactor that might swap the check order in statusInfo.
    func testRunningChildrenOutranksPlanReady() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: true,
            permissionQueue: [planReadyEntry()]
        )
        let info = statusInfo(for: tab)

        // Must be yellow (0xF59E0B), not green.
        XCTAssertEqual(
            info.color,
            Color(hex: yellowHex),
            "hasRunningChildren must outrank planReady: expected yellow (0xF59E0B) but got a different color"
        )
        // Must pulse.
        XCTAssertTrue(
            info.pulse,
            "hasRunningChildren state must pulse (active background work indicator)"
        )
    }

    // MARK: - Isolation checks (prevent false confidence)

    /// plan-ready alone (tab idle, no running children) resolves green.
    func testPlanReadyAloneResolvesGreen() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: nil,
            permissionQueue: [planReadyEntry()]
        )
        let info = statusInfo(for: tab)

        XCTAssertEqual(
            info.color, .green,
            "planReady alone must resolve green when no running children are present"
        )
        XCTAssertFalse(
            info.pulse,
            "planReady state must not pulse"
        )
    }

    /// running-children alone (no plan-ready in queue) resolves yellow + pulse.
    func testRunningChildrenAloneResolvesYellowPulse() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: true,
            permissionQueue: []
        )
        let info = statusInfo(for: tab)

        XCTAssertEqual(
            info.color,
            Color(hex: yellowHex),
            "hasRunningChildren alone must resolve yellow (0xF59E0B)"
        )
        XCTAssertTrue(info.pulse, "hasRunningChildren state must pulse")
    }

    /// Neither flag: resolves default gray.
    func testNeitherFlagResolvesGray() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: nil,
            permissionQueue: []
        )
        let info = statusInfo(for: tab)

        XCTAssertEqual(
            info.color,
            Color(hex: 0x8A8A80),
            "No active flags must resolve default gray (0x8A8A80)"
        )
        XCTAssertFalse(info.pulse, "Default gray must not pulse")
    }

    // MARK: - Completed status parity

    /// plan-ready resolves green when status == .completed (not just .idle).
    func testPlanReadyResolvesGreenOnCompleted() {
        let tab = makeTab(
            status: .completed,
            hasRunningChildren: nil,
            permissionQueue: [planReadyEntry()]
        )
        let info = statusInfo(for: tab)

        XCTAssertEqual(info.color, .green,
            "planReady must resolve green on .completed status too")
        XCTAssertFalse(info.pulse)
    }

    /// running-children outranks plan-ready even when tab status is .completed.
    func testRunningChildrenOutranksPlanReadyOnCompleted() {
        let tab = makeTab(
            status: .completed,
            hasRunningChildren: true,
            permissionQueue: [planReadyEntry()]
        )
        let info = statusInfo(for: tab)

        XCTAssertEqual(
            info.color,
            Color(hex: yellowHex),
            "hasRunningChildren must outrank planReady on .completed status too"
        )
        XCTAssertTrue(info.pulse)
    }
}
