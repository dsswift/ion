import SwiftUI
import XCTest
@testable import IonRemote

/// The tab-list restraint pass: pins the row's reduced anatomy.
///
/// The row used to stack up to four text lines at three sizes plus a leading
/// dot, a harness badge, a folder glyph, a git segment, and a trailing pin. It
/// is now a status dot (non-idle only), a title, and exactly ONE subtitle line.
///
/// The critical guard here is `testNonIdleStatesRenderTheDot`: "full restraint"
/// must not silently eat a failure signal. A dead background agent has to stay
/// distinguishable from an idle conversation on the only screen that lists both,
/// and the status dot is a documented desktop↔iOS parity surface (root
/// AGENTS.md § "Common parity surfaces": snapshot.ts → RemoteTabState.status →
/// TabRowView.statusInfo).
final class TabRowRestraintTests: XCTestCase {

    // MARK: - Helpers

    private let since = Date(timeIntervalSince1970: 1_000_000)
    private var now: Date { since.addingTimeInterval(2 * 60 * 60) }

    private func makeTab(
        status: TabStatus = .idle,
        hasRunningChildren: Bool? = nil,
        permissionQueue: [PermissionRequest] = [],
        backgroundShellCount: Int? = nil,
        workingDirectory: String = "/tmp/orion",
        lastMessage: String? = nil,
        isTerminalOnly: Bool? = nil
    ) -> RemoteTabState {
        var tab = RemoteTabState(
            id: "tab-restraint",
            title: "Restraint",
            customTitle: nil,
            status: status,
            workingDirectory: workingDirectory,
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: permissionQueue,
            isTerminalOnly: isTerminalOnly,
            hasRunningChildren: hasRunningChildren
        )
        tab.backgroundShellCount = backgroundShellCount
        tab.lastMessage = lastMessage
        return tab
    }

    private func permission(_ toolName: String) -> PermissionRequest {
        PermissionRequest(questionId: "qid-\(toolName)", toolName: toolName, toolInput: nil, options: [])
    }

    // MARK: - The dot: hidden when idle, shown when actionable

    func testIdleTabHidesTheDot() {
        let row = TabRowView(tab: makeTab(status: .idle))
        XCTAssertTrue(
            row.isIdle,
            "an idle tab must fold to isIdle so the row suppresses its status dot"
        )
    }

    /// A completed run with nothing pending is also quiet — it needs no dot.
    func testCompletedTabHidesTheDot() {
        XCTAssertTrue(TabRowView(tab: makeTab(status: .completed)).isIdle)
    }

    /// Every actionable state must still render a dot. This is the guard against
    /// the restraint pass hiding a failure the operator needs to see.
    func testNonIdleStatesRenderTheDot() {
        let cases: [(String, RemoteTabState)] = [
            ("failed", makeTab(status: .failed)),
            ("dead", makeTab(status: .dead)),
            ("running", makeTab(status: .running)),
            ("connecting", makeTab(status: .connecting)),
            ("running children", makeTab(status: .idle, hasRunningChildren: true)),
            ("background shells", makeTab(status: .idle, backgroundShellCount: 2)),
            ("permission", makeTab(status: .idle, permissionQueue: [permission("Bash")])),
            ("plan ready", makeTab(status: .idle, permissionQueue: [permission("ExitPlanMode")])),
            ("question", makeTab(status: .idle, permissionQueue: [permission("AskUserQuestion")])),
        ]
        for (label, tab) in cases {
            XCTAssertFalse(
                TabRowView(tab: tab).isIdle,
                "\(label) is actionable and must render a status dot — hiding it would make it indistinguishable from an idle row"
            )
        }
    }

    /// `isIdle` must read the shared classifier, never a private copy of the
    /// cascade, so the dot's visibility can never disagree with its color.
    func testIdleGateFoldsTheSharedClassifier() {
        for tab in [
            makeTab(status: .idle),
            makeTab(status: .failed),
            makeTab(status: .idle, hasRunningChildren: true),
            makeTab(status: .idle, backgroundShellCount: 1),
        ] {
            let classifierSaysIdle =
                TabStatusRollup.classify(tab).priority == TabStatusRollup.priorityIdle
            XCTAssertEqual(
                TabRowView(tab: tab).isIdle, classifierSaysIdle,
                "isIdle must equal the shared classifier's idle verdict"
            )
        }
    }

    // MARK: - The subtitle: exactly one line, by precedence

    /// Precedence 1: an actionable status outranks conversation content.
    func testStatusOutranksMessagePreview() {
        let tab = makeTab(
            status: .idle,
            hasRunningChildren: true,
            lastMessage: "this preview must not win"
        )
        let subtitle = TabRowView(tab: tab, idleSince: since).subtitle(at: now)
        XCTAssertEqual(subtitle?.text, "Working… · 2h ago")
        XCTAssertEqual(subtitle?.color, TabStatusRollup.childrenYellow)
    }

    func testRunningRendersItsOwnLabel() {
        let tab = makeTab(status: .running, lastMessage: "ignored while running")
        XCTAssertEqual(TabRowView(tab: tab, idleSince: since).subtitle(at: now)?.text, "Running…")
    }

    /// Precedence 2: an idle tab shows the conversation preview.
    func testIdleTabShowsMessagePreview() {
        let tab = makeTab(status: .idle, lastMessage: "Landed the theme tokens")
        XCTAssertEqual(
            TabRowView(tab: tab, idleSince: since).subtitle(at: now)?.text,
            "Landed the theme tokens"
        )
    }

    /// Precedence 3: no message → the directory name, so a fresh conversation
    /// still says where it lives.
    func testIdleTabWithNoMessageFallsBackToDirectory() {
        let tab = makeTab(status: .idle, workingDirectory: "/Users/x/src/orion", lastMessage: nil)
        XCTAssertEqual(TabRowView(tab: tab, idleSince: since).subtitle(at: now)?.text, "orion")
    }

    /// An empty message string is treated as absent, not rendered as a blank
    /// line — otherwise the row would show an empty subtitle.
    func testEmptyMessageFallsBackToDirectory() {
        let tab = makeTab(status: .idle, workingDirectory: "/tmp/orion", lastMessage: "")
        XCTAssertEqual(TabRowView(tab: tab, idleSince: since).subtitle(at: now)?.text, "orion")
    }

    /// The subtitle is a relative timestamp on the status branch, so it must
    /// advance with the clock rather than freeze at its first rendered value.
    func testStatusSubtitleTracksElapsedTime() {
        let tab = makeTab(status: .idle, hasRunningChildren: true)
        let row = TabRowView(tab: tab, idleSince: since)
        XCTAssertEqual(row.subtitle(at: since.addingTimeInterval(30))?.text, "Working… · just now")
        XCTAssertEqual(row.subtitle(at: since.addingTimeInterval(600))?.text, "Working… · 10m ago")
        XCTAssertEqual(row.subtitle(at: since.addingTimeInterval(86_400))?.text, "Working… · 1d ago")
    }

    // MARK: - Removed chrome must not regrow

    /// The row's third and fourth registers were deleted deliberately. A source
    /// guard is the only way to assert their absence — a reflection check cannot
    /// see what a view body does not draw.
    func testRowDoesNotRegrowTheStrippedChrome() throws {
        let src = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("IonRemote/Views/TabRowView.swift"),
            encoding: .utf8
        )
        for (fragment, what) in [
            ("harnessBadge", "the harness badge"),
            ("gitSegment", "the git branch/ahead/behind segment"),
            ("systemName: \"folder\"", "the folder glyph"),
            ("pin.fill", "the trailing pin (group membership is conveyed by the section)"),
            ("Text(\"•\")", "the bullet separators"),
        ] {
            XCTAssertFalse(
                src.contains(fragment),
                "\(what) was removed from the tab row in the restraint pass and must not regrow"
            )
        }
    }

    /// The base-moved indicator is the ONE metadata glyph that survives, because
    /// root AGENTS.md § "Common parity surfaces" names TabRowView as its iOS
    /// render site (`RemoteWorktree.needsSync`). Removing it with the rest of the
    /// strip would have broken a documented contract silently.
    func testBaseMovedIndicatorSurvives() throws {
        let src = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("IonRemote/Views/TabRowView.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(
            src.contains("isWorktreeBaseStale"),
            """
            The base-moved indicator is a documented desktop↔iOS parity surface \
            (root AGENTS.md → RemoteWorktree.needsSync → "Tab row indicator \
            (TabRowView)"). It must survive the restraint pass.
            """
        )
    }

    // MARK: - Header restraint

    /// The grey slab behind each section header was a regression: it made five
    /// filled bars the heaviest elements on the screen. The header is text on
    /// the list background.
    func testGroupHeaderCarriesNoFilledSlab() throws {
        let src = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("IonRemote/Views/TabListGroupHeader.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(
            src.contains("RoundedRectangle"),
            """
            The section header must not paint a filled container. It reads as \
            quiet text on the list background; a slab competes with the rows it \
            labels.
            """
        )
        XCTAssertFalse(
            src.contains("theme.surfaceSecondary"),
            "the header surface stays transparent so the list background shows through"
        )
    }
}
