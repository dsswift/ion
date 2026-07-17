import XCTest
@testable import IonRemote

/// Pins the tab-create confirm-or-resend delivery loop
/// (`SessionViewModel+PendingCreate`).
///
/// The bug this guards: a `createTab`/`createTerminalTab` sent into a wedged
/// transport (a zombie LAN socket after a background/resume cycle) succeeds
/// locally without throwing and is silently lost — the essential-queue/requeue
/// paths never fire because nothing errored. These tests assert the tracker
/// that closes the hole: each create is recorded as pending, resent on timeout,
/// confirmed (and navigated) when the desktop echoes its clientCmdId back, and
/// cleared on hard disconnect. Each would fail to even compile against the
/// pre-fix code (no tracker), and asserts behavior that did not exist before.
@MainActor
final class PendingCreateTests: XCTestCase {

    private func makeTab(id: String) -> RemoteTabState {
        RemoteTabState(
            id: id,
            title: id,
            customTitle: nil,
            status: .idle,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: [],
            hasEngineExtension: false
        )
    }

    private func seedPending(_ vm: SessionViewModel, id: String, attempts: Int = 1) {
        vm.pendingCreates[id] = SessionViewModel.PendingCreate(
            command: .createTab(workingDirectory: "/tmp", clientCmdId: id),
            clientCmdId: id,
            attempts: attempts,
            timeoutTask: nil
        )
    }

    // MARK: - Registration

    func testSendTrackedCreateRegistersPending() {
        let vm = SessionViewModel()  // transport == nil: send is best-effort, no network
        vm.sendTrackedCreate(.createTab(workingDirectory: "/tmp", clientCmdId: "cc-a"), clientCmdId: "cc-a")

        XCTAssertNotNil(vm.pendingCreates["cc-a"])
        XCTAssertEqual(vm.pendingCreates["cc-a"]?.attempts, 1)

        vm.clearPendingCreates()  // cancel the scheduled timeout so it doesn't outlive the test
    }

    // MARK: - Confirmation via the desktop_tab_created echo

    func testTabCreatedEchoConfirmsPendingAndNavigates() {
        let vm = SessionViewModel()
        seedPending(vm, id: "cc-b")

        vm.handleEvent(.tabCreated(tab: makeTab(id: "tab-b"), clientCmdId: "cc-b"))

        // Confirmed: the pending entry is cleared so no resend fires...
        XCTAssertNil(vm.pendingCreates["cc-b"])
        // ...and a matched (locally-initiated) create drives navigation.
        XCTAssertEqual(vm.pendingNavigationTabId, "tab-b")
    }

    func testUnmatchedTabCreatedAppendsWithoutNavigating() {
        let vm = SessionViewModel()
        // No pending entry — this models a desktop-originated tab (or an echo
        // for a create this device never issued).
        vm.handleEvent(.tabCreated(tab: makeTab(id: "tab-remote"), clientCmdId: "unknown-id"))

        XCTAssertTrue(vm.tabs.contains(where: { $0.id == "tab-remote" }))
        XCTAssertNil(vm.pendingNavigationTabId)

        // A nil clientCmdId (no correlation) likewise must not navigate or crash.
        vm.handleEvent(.tabCreated(tab: makeTab(id: "tab-remote-2"), clientCmdId: nil))
        XCTAssertNil(vm.pendingNavigationTabId)
    }

    func testConfirmCreateReturnsFalseForUnknownOrNil() {
        let vm = SessionViewModel()
        XCTAssertFalse(vm.confirmCreate(clientCmdId: "never-sent"))
        XCTAssertFalse(vm.confirmCreate(clientCmdId: nil))
    }

    // MARK: - Resend / give-up on timeout

    func testTimeoutResendsWhileUnderMaxAttempts() {
        let vm = SessionViewModel()
        seedPending(vm, id: "cc-c", attempts: 1)

        vm.onCreateTimeout(clientCmdId: "cc-c")

        // Still pending, attempt count advanced — the create was resent, not lost.
        XCTAssertEqual(vm.pendingCreates["cc-c"]?.attempts, 2)

        vm.clearPendingCreates()  // cancel the freshly-armed timeout
    }

    func testTimeoutGivesUpAtMaxAttempts() {
        let vm = SessionViewModel()
        seedPending(vm, id: "cc-d", attempts: SessionViewModel.createMaxAttempts)

        vm.onCreateTimeout(clientCmdId: "cc-d")

        // Exhausted: the entry is dropped (a visible failure toast is surfaced).
        XCTAssertNil(vm.pendingCreates["cc-d"])
    }

    // MARK: - Hard disconnect clears the tracker (no replay against a new pairing)

    func testClearPendingCreatesEmptiesTracker() {
        let vm = SessionViewModel()
        seedPending(vm, id: "cc-e1")
        seedPending(vm, id: "cc-e2")
        XCTAssertEqual(vm.pendingCreates.count, 2)

        vm.clearPendingCreates()

        XCTAssertTrue(vm.pendingCreates.isEmpty)
    }
}
