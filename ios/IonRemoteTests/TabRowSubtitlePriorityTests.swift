import XCTest
import SwiftUI
@testable import IonRemote

/// Pins the `TabRowView` SUBTITLE (text + color) priority order so it can never
/// diverge from the status DOT.
///
/// The dot delegates to the shared classifier `TabStatusRollup.classify`, which
/// ranks running-children (yellow pulse) ABOVE plan-ready (green). The subtitle
/// used to run a separate older cascade in `idleLabel(at:since:)` /
/// `idleLabelColor` that checked plan-ready/question from `permissionQueue`
/// FIRST and was blind to `tab.hasRunningChildren`. Result: an idle tab with
/// running children that still carried an ExitPlanMode entry showed a yellow dot
/// but a green "Plan ready · …" subtitle.
///
/// The fix folds the SAME classifier for the subtitle. This test reads the
/// subtitle (not the dot) via `idleLabel(at:since:)` / `idleLabelColor` and pins:
///   1. idle + hasRunningChildren + ExitPlanMode entry → "Working… · …" yellow,
///      NOT "Plan ready" / green. (Fails on the pre-fix cascade.)
///   2. idle + ExitPlanMode, no children → "Plan ready · …", green.
///   3. idle + AskUserQuestion, no children → "Waiting on you · …", blue.
///   4. idle + hasRunningChildren, empty queue → "Working… · …", yellow.
///
/// Desktop↔iOS parity: mirrors the running-children > plan-ready ordering the
/// desktop folds for both dot and subtitle. See AGENTS.md § "Common parity
/// surfaces".
final class TabRowSubtitlePriorityTests: XCTestCase {

    // MARK: - Helpers

    private let yellowHex: UInt = 0xF59E0B   // childrenYellow
    private let blueHex: UInt = 0x4A9EF5     // questionBlue

    /// A fixed now/since pair so `relativeTime` is deterministic. 2h apart →
    /// the elapsed suffix is always "2h ago".
    private let since = Date(timeIntervalSince1970: 1_000_000)
    private var now: Date { since.addingTimeInterval(2 * 60 * 60) }
    private let elapsedSuffix = "2h ago"

    /// Build a minimal RemoteTabState with the fields the test varies.
    private func makeTab(
        status: TabStatus = .idle,
        hasRunningChildren: Bool? = nil,
        permissionQueue: [PermissionRequest] = []
    ) -> RemoteTabState {
        RemoteTabState(
            id: "tab-subtitle-test",
            title: "Subtitle Test",
            customTitle: nil,
            status: status,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: permissionQueue,
            hasRunningChildren: hasRunningChildren
        )
    }

    /// A PermissionRequest representing a plan-ready (ExitPlanMode) denial.
    private func planReadyEntry() -> PermissionRequest {
        PermissionRequest(
            questionId: "qid-exitplan",
            toolName: "ExitPlanMode",
            toolInput: nil,
            options: []
        )
    }

    /// A PermissionRequest representing a question (AskUserQuestion) denial.
    private func questionEntry() -> PermissionRequest {
        PermissionRequest(
            questionId: "qid-question",
            toolName: "AskUserQuestion",
            toolInput: nil,
            options: []
        )
    }

    /// Read the subtitle text for a tab with the deterministic now/since pair.
    private func subtitle(for tab: RemoteTabState) -> String {
        TabRowView(tab: tab).idleLabel(at: now, since: since)
    }

    /// Read the subtitle color for a tab.
    private func subtitleColor(for tab: RemoteTabState) -> Color {
        TabRowView(tab: tab).idleLabelColor
    }

    // MARK: - Core parity test (fails on pre-fix cascade)

    /// idle + hasRunningChildren + ExitPlanMode entry → running-children label,
    /// NOT plan-ready. This is the regression gate: the pre-fix cascade returned
    /// "Plan ready · …" green because it checked hasPlanReady first and was blind
    /// to hasRunningChildren.
    func testRunningChildrenSubtitleOutranksPlanReady() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: true,
            permissionQueue: [planReadyEntry()]
        )

        XCTAssertEqual(
            subtitle(for: tab),
            "Working… · \(elapsedSuffix)",
            "running-children must outrank plan-ready in the subtitle: expected the Working… label, not Plan ready"
        )
        XCTAssertEqual(
            subtitleColor(for: tab),
            Color(hex: yellowHex),
            "running-children subtitle must be yellow (0xF59E0B), not green"
        )
    }

    // MARK: - Isolation checks

    /// idle + ExitPlanMode, no children → plan-ready green.
    func testPlanReadyAloneResolvesGreenSubtitle() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: nil,
            permissionQueue: [planReadyEntry()]
        )

        XCTAssertEqual(subtitle(for: tab), "Plan ready · \(elapsedSuffix)")
        XCTAssertEqual(subtitleColor(for: tab), .green)
    }

    /// idle + AskUserQuestion, no children → question blue.
    func testQuestionAloneResolvesBlueSubtitle() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: nil,
            permissionQueue: [questionEntry()]
        )

        XCTAssertEqual(subtitle(for: tab), "Waiting on you · \(elapsedSuffix)")
        XCTAssertEqual(subtitleColor(for: tab), Color(hex: blueHex))
    }

    /// idle + hasRunningChildren, empty queue → running-children label.
    func testRunningChildrenAloneResolvesYellowSubtitle() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: true,
            permissionQueue: []
        )

        XCTAssertEqual(subtitle(for: tab), "Working… · \(elapsedSuffix)")
        XCTAssertEqual(subtitleColor(for: tab), Color(hex: yellowHex))
    }
}
