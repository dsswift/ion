import XCTest
import SwiftUI
@testable import IonRemote

/// Pins the inbox list's layout rules: one indent column per tree level, and
/// one detail line per conversation row whose content depends on whether the
/// row already sits under its project.
final class InboxRowLayoutTests: XCTestCase {

    private func tab(directory: String = "/work/ion", lastMessage: String? = nil, extra: String = "") throws -> RemoteTabState {
        let message = lastMessage.map { ", \"lastMessage\": \"\($0)\"" } ?? ""
        let json = """
        {"id":"t1","title":"Fix login","status":"idle","workingDirectory":"\(directory)",
        "permissionMode":"auto","permissionQueue":[],"inboxState":"active"\(message)\(extra)}
        """.data(using: .utf8)!
        return try JSONDecoder().decode(RemoteTabState.self, from: json)
    }

    // MARK: - Indent

    func testRowsDirectlyInACardStartAtTheHeadersEdge() {
        let header = InboxLayout.insets(level: 0)
        let direct = InboxLayout.insets(level: 1)
        let nested = InboxLayout.insets(level: 2)
        // The card already groups a project's rows, so the first level does
        // not step in again.
        XCTAssertEqual(direct.leading, header.leading)
        XCTAssertEqual(nested.leading - direct.leading, InboxLayout.childIndent)
        // One trailing gutter at every depth, so status pills form a column.
        XCTAssertEqual(header.trailing, nested.trailing)
    }

    func testOnlyRowsInsideAProjectAreDrawnOnACard() {
        XCTAssertTrue(InboxLayout.isOnCard(level: 0, kind: .cardHeader))
        XCTAssertTrue(InboxLayout.isOnCard(level: 0, kind: .cardHeaderAlone))
        XCTAssertTrue(InboxLayout.isOnCard(level: 0, kind: .cardFooter))
        XCTAssertFalse(InboxLayout.isOnCard(level: 0, kind: .cardGap))
        XCTAssertTrue(InboxLayout.isOnCard(level: 1, kind: .groupHeader))
        XCTAssertTrue(InboxLayout.isOnCard(level: 2, kind: .content))
        XCTAssertFalse(InboxLayout.isOnCard(level: 0, kind: .content), "the settled shelf sits on the list itself")
    }

    // MARK: - Detail line

    func testTreeRowShowsTheLastMessageNotTheProject() throws {
        let row = try tab(lastMessage: "Tests pass now")
        XCTAssertEqual(InboxRowView.detail(for: row, showsProject: false), .preview("Tests pass now"))
    }

    func testTreeRowWithNoMessageIsTitleOnly() throws {
        XCTAssertNil(InboxRowView.detail(for: try tab(), showsProject: false))
        XCTAssertNil(InboxRowView.detail(for: try tab(lastMessage: "   "), showsProject: false))
    }

    func testFlatRowNamesItsProject() throws {
        let row = try tab(directory: "/work/ion", lastMessage: "ignored here")
        XCTAssertEqual(InboxRowView.detail(for: row, showsProject: true), .project("ion", autoSettled: false))
    }

    func testFlatRowMarksAnAutoSettledConversation() throws {
        let row = try tab(extra: ", \"settledOverride\": \"auto\"")
        XCTAssertEqual(InboxRowView.detail(for: row, showsProject: true), .project("ion", autoSettled: true))
    }

    func testHomeDirectoryHasNoProjectLine() throws {
        XCTAssertNil(InboxRowView.detail(for: try tab(directory: "~"), showsProject: true))
    }

    func testPreviewDropsMarkdownAndCollapsesToOneLine() {
        XCTAssertEqual(InboxRowView.plainPreview("**What was wrong?**\n\nThe list had `no` layout."), "What was wrong? The list had no layout.")
        XCTAssertEqual(InboxRowView.plainPreview("## Done\n- first\n- second"), "Done first second")
        XCTAssertEqual(InboxRowView.plainPreview("See [the doc](https://example.org/x) > now"), "See the doc > now")
        XCTAssertEqual(InboxRowView.plainPreview("   \n  "), "")
    }

    func testTreeRowPreviewIsPlainText() throws {
        let row = try tab(lastMessage: "**Done.** Tests pass")
        XCTAssertEqual(InboxRowView.detail(for: row, showsProject: false), .preview("Done. Tests pass"))
    }

    // MARK: - Worktree header

    func testHeaderDropsItsNameOnlyWhenItsOneRowRepeatsIt() throws {
        let state = try JSONDecoder().decode(RemoteWorktreeState.self, from: """
        {"repoPath":"/repo","worktrees":[{"worktreePath":"/repo/.ion/worktrees/a","branchName":"wt/a","label":"a",
        "title":"Fix login","head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
        "needsSync":false,"safeToDiscard":true}],"benches":[]}
        """.data(using: .utf8)!)
        let worktree = state.worktrees[0]
        let same = try tab()
        XCTAssertEqual(worktree.displayName, "Fix login")
        XCTAssertTrue(InboxWorktreeGroup<EmptyView>.headerRepeatsRow(worktree: worktree, visibleTabs: [same]))
        XCTAssertFalse(InboxWorktreeGroup<EmptyView>.headerRepeatsRow(worktree: worktree, visibleTabs: []),
                       "a collapsed group with no visible row must keep its name")
        XCTAssertFalse(InboxWorktreeGroup<EmptyView>.headerRepeatsRow(worktree: worktree, visibleTabs: [same, same]))
    }

    // MARK: - Collapsed groups and the bench

    private func viewSource(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// A collapsed Source Repository group keeps its pinned, selected, and
    /// working rows, as every other group does. It used to hide all of them.
    func testCollapsedSourceGroupKeepsItsPinnedRows() throws {
        let source = try viewSource("TabListView+Inbox.swift")
        XCTAssertTrue(source.contains("InboxNavigator.collapsedRows(project.sourceTabs, activeTabId: currentTabId)"))
    }

    func testPinnedRowSurvivesCollapse() throws {
        let pinned = try tab(extra: ", \"pinnedAt\": 1000")
        let rows = InboxNavigator.collapsedRows([pinned], activeTabId: nil)
        XCTAssertEqual(rows.map(\.id), ["t1"])
        XCTAssertTrue(InboxNavigator.collapsedRows([try tab()], activeTabId: nil).isEmpty)
    }

    /// The bench does not collapse: no expansion state, no chevron.
    func testBenchGroupHasNoCollapsedState() throws {
        let source = try viewSource("InboxBenchGroup.swift")
        XCTAssertFalse(source.contains("isExpanded = expanded.contains"))
        XCTAssertTrue(source.contains("showsChevron: false"))
    }

    /// The bench terminal is drawn as a two-line row like the conversations
    /// beside it, not as a thin label.
    func testBenchTerminalRowHasATitleAndADetailLine() throws {
        let source = try viewSource("InboxBenchTerminalRow.swift")
        XCTAssertTrue(source.contains("Text(\"Bench terminal\")"))
        XCTAssertTrue(source.contains(".font(IonType.body)"))
    }

    // MARK: - Action lock

    func testAnyInFlightActionLocksTheRepositorysActions() {
        XCTAssertFalse(SessionViewModel.worktreeActionsLocked(busyPath: nil, benchBusy: false, pipelinePhase: nil))
        XCTAssertTrue(SessionViewModel.worktreeActionsLocked(busyPath: "/wt/a", benchBusy: false, pipelinePhase: nil),
                      "one worktree's action holds every other worktree's")
        XCTAssertTrue(SessionViewModel.worktreeActionsLocked(busyPath: nil, benchBusy: true, pipelinePhase: nil))
        XCTAssertTrue(SessionViewModel.worktreeActionsLocked(busyPath: nil, benchBusy: false, pipelinePhase: .syncing))
        XCTAssertTrue(SessionViewModel.worktreeActionsLocked(busyPath: nil, benchBusy: false, pipelinePhase: .awaitingAiConfirm))
        XCTAssertFalse(SessionViewModel.worktreeActionsLocked(busyPath: nil, benchBusy: false, pipelinePhase: .done))
        XCTAssertFalse(SessionViewModel.worktreeActionsLocked(busyPath: nil, benchBusy: false, pipelinePhase: .failed))
    }

    @MainActor
    func testStartingTheSyncPipelineMarksTheBenchBusyAtOnce() {
        let vm = SessionViewModel()
        XCTAssertFalse(vm.worktreeActionsLocked(repoPath: "/repo"))
        vm.startWorktreePipeline(repoPath: "/repo", sourceBranch: "main")
        XCTAssertTrue(vm.worktreeActionsLocked(repoPath: "/repo"), "the control must answer the tap, not the server's first push")
    }

    /// The pin and sync marks on a worktree header are buttons, not pictures.
    func testWorktreeHeaderMarksAreActions() throws {
        let source = try viewSource("WorktreeRowView.swift")
        XCTAssertTrue(source.contains("action: onUpdatePin"))
        XCTAssertTrue(source.contains(".disabled(actionsLocked)"))
        XCTAssertEqual(WorktreeRowView.actionSize, IonSpace.Metric.standardRowHeight)
    }

    // MARK: - Density

    func testHeadersAreShorterThanContentRows() {
        XCTAssertLessThan(InboxLayout.minHeight(.groupHeader), InboxLayout.minHeight(.content))
        XCTAssertEqual(InboxLayout.minHeight(.content), IonSpace.Metric.standardRowHeight)
    }

    // MARK: - Rollup

    func testProjectRollupCountsOnlyWhatRowsShow() throws {
        let idle = try tab()
        let working = try tab(extra: ", \"hasRunningChildren\": true")
        let counts = InboxProjectRollup.counts(for: [idle, working])
        XCTAssertEqual(counts.needsYou, 0)
        XCTAssertEqual(counts.failed, 0)
        XCTAssertEqual(counts.working, InboxRowView.pill(for: working) == .working ? 1 : 0)
        XCTAssertTrue(InboxProjectRollup.counts(for: [idle]).isEmpty)
    }

    func testRollupChipsSayWhatTheyCount() {
        XCTAssertEqual(InboxProjectRollup.label(.needsYou, 3), "3 waiting on you")
        XCTAssertEqual(InboxProjectRollup.label(.failed, 1), "1 failed")
        XCTAssertEqual(InboxProjectRollup.label(.working, 2), "2 working")
    }

    /// The bench terminal's glyph is pink only while the terminal runs.
    func testIdleBenchTerminalIsNotDrawnInTheRunningColour() throws {
        let source = try viewSource("InboxBenchTerminalRow.swift")
        XCTAssertTrue(source.contains("tab.hasRunningTerminal == true ? theme.statusBash : theme.textTertiary"))
    }

    // MARK: - Pill

    func testIdleReadRowHasNoPill() throws {
        XCTAssertNil(InboxRowView.pill(for: try tab()))
    }

    // MARK: - Usage limits

    /// The snapshot fields as `projectTab` sends them (`server/src/store/remote-projection.ts`).
    func testAConversationItsAccountStoppedReadsLimitedUntilTheReset() throws {
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let row = try tab(extra: #", "status":"failed", "limitedUntil":1800000000000, "limitType":"five_hour""#)

        XCTAssertEqual(InboxRowView.pill(for: row, now: reset.addingTimeInterval(-60)), .limited)
        XCTAssertNotEqual(InboxRowView.pill(for: row, now: reset.addingTimeInterval(60)), .limited)
        XCTAssertNil(InboxRowView.heldLabel(for: row))
    }

    func testAHeldPromptSaysWhenTheServerWillSendIt() throws {
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let resuming = try tab(extra: #", "limitedUntil":1800000000000, "deferredRelease":"limit-reset", "quiet":true"#)
        let queued = try tab(extra: #", "deferredRelease":"spare-quota""#)

        XCTAssertEqual(InboxRowView.heldLabel(for: resuming, now: reset.addingTimeInterval(-60)), "Resumes \(reset.formatted(date: .omitted, time: .shortened))")
        XCTAssertEqual(InboxRowView.heldLabel(for: queued), "Queued for spare quota")
        XCTAssertEqual(resuming.quiet, true)
    }

    func testWorkingLastPutsWorkingConversationsBelowTheRestInTheChosenOrder() throws {
        func row(_ id: String, status: String, at: Int) throws -> RemoteTabState {
            let json = #"{"id":"\#(id)","title":"\#(id)","status":"\#(status)","workingDirectory":"/w","permissionMode":"auto","permissionQueue":[],"lastActivityAt":\#(at)}"#
            return try JSONDecoder().decode(RemoteTabState.self, from: Data(json.utf8))
        }
        let rows = [try row("working-new", status: "running", at: 40), try row("idle-old", status: "idle", at: 10),
                    try row("working-old", status: "running", at: 20), try row("idle-new", status: "idle", at: 30)]

        XCTAssertEqual(InboxNavigator.sorted(rows, by: .recent, workingLast: true).map(\.id), ["idle-new", "idle-old", "working-new", "working-old"])
        XCTAssertEqual(InboxNavigator.sorted(rows, by: .recent, workingLast: false).map(\.id), ["working-new", "idle-new", "working-old", "idle-old"])
    }
}
