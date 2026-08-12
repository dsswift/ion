import XCTest
@testable import IonRemote

final class RunDurationStateTests: XCTestCase {
    private func makeTab(status: TabStatus = .idle) -> RemoteTabState {
        RemoteTabState(
            id: "run-tab",
            title: "Run",
            status: status,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            permissionQueue: []
        )
    }

    @MainActor
    func testTaskCompletionStoresDurationAndReason() {
        let viewModel = SessionViewModel()
        viewModel.tabs = [makeTab(status: .running)]

        viewModel.handleTaskComplete(tabId: "run-tab", durationMs: 62_007, reason: .aborted)

        XCTAssertEqual(viewModel.tab(for: "run-tab")?.lastRunDurationMs, 62_007)
        XCTAssertEqual(viewModel.tab(for: "run-tab")?.lastRunReason, .aborted)
    }

    @MainActor
    func testRunningStatusClearsPriorCompletionMetadata() {
        let viewModel = SessionViewModel()
        var tab = makeTab()
        tab.lastRunDurationMs = 12_000
        tab.lastRunReason = .normal
        viewModel.tabs = [tab]

        viewModel.handleTabStatus(tabId: "run-tab", status: .running)

        XCTAssertNil(viewModel.tab(for: "run-tab")?.lastRunDurationMs)
        XCTAssertNil(viewModel.tab(for: "run-tab")?.lastRunReason)
    }

    func testRunDurationLabelUsesReasonAndSharedFormatter() {
        XCTAssertEqual(RunDurationRow(durationMs: 1_000, reason: .normal).label, "Completed in 1s")
        XCTAssertEqual(RunDurationRow(durationMs: 1_000, reason: .aborted).label, "Stopped after 1s")
        XCTAssertEqual(RunDurationRow(durationMs: 1_000, reason: .maxTurns).label, "Ended after 1s")
    }
}
