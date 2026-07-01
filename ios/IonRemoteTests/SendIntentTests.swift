import XCTest
@testable import IonRemote

// MARK: - SendIntentTests
//
// Seven tests from the blue-whistling-cave.md verification section.
// Each test is designed to fail on pre-fix code (no intent classification,
// single `send()` that always toasts) and pass after the fix.
//
// Tests use SessionViewModel directly and inspect:
//   - toastMessages (must be empty for automatic sends)
//   - pendingEssentialQueue (must contain deduped entries)
//   - In-session send behavior via the public API surface
//
// We do NOT exercise live transport sends (no mock transport injected);
// we test the routing/queueing logic in `send(_:intent:)`.

@MainActor
final class SendIntentTests: XCTestCase {

    // MARK: - Test 1: automatic essential while disconnected does not toast

    func testAutomaticEssentialWhileDisconnectedDoesNotToast() {
        let vm = SessionViewModel()
        // Ensure not connected (default state)
        XCTAssertNotEqual(vm.connectionState, .connected)

        vm.send(.loadConversation(tabId: "tab-1", before: nil), intent: .automaticEssential)

        // No toast must have been added
        XCTAssertTrue(vm.toastMessages.isEmpty,
            "An automatic essential send while disconnected must never produce a toast")

        // Command must be enqueued
        XCTAssertFalse(vm.pendingEssentialQueue.isEmpty,
            "An automatic essential send while disconnected must be enqueued")
        XCTAssertEqual(vm.pendingEssentialQueue.first?.key, "loadConversation:tab-1")
    }

    // MARK: - Test 2: dedupe last-write-wins

    func testEssentialQueueDedupeLastWriteWins() {
        let vm = SessionViewModel()
        XCTAssertNotEqual(vm.connectionState, .connected)

        // Enqueue loadConversation for tabA three times -- should collapse to one entry
        vm.send(.loadConversation(tabId: "tabA", before: nil), intent: .automaticEssential)
        vm.send(.loadConversation(tabId: "tabA", before: nil), intent: .automaticEssential)
        vm.send(.loadConversation(tabId: "tabA", before: nil), intent: .automaticEssential)

        let aEntries = vm.pendingEssentialQueue.filter { $0.key == "loadConversation:tabA" }
        XCTAssertEqual(aEntries.count, 1,
            "Three enqueues for the same key must deduplicate to one entry")

        // Enqueue for tabB -- must be a separate entry (distinct key)
        vm.send(.loadConversation(tabId: "tabB", before: nil), intent: .automaticEssential)
        let bEntries = vm.pendingEssentialQueue.filter { $0.key == "loadConversation:tabB" }
        XCTAssertEqual(bEntries.count, 1,
            "A different key must be a separate queue entry")

        // Both keys present (total 2 distinct entries)
        XCTAssertEqual(vm.pendingEssentialQueue.count, 2,
            "Queue must hold one entry per distinct key")
    }

    // MARK: - Test 3: flush on connect runs each deduped essential once

    func testFlushOnConnectRunsEachDedupedEssentialOnce() {
        let vm = SessionViewModel()
        XCTAssertNotEqual(vm.connectionState, .connected)

        // Enqueue several distinct keys while disconnected
        vm.send(.loadConversation(tabId: "tab-A", before: nil), intent: .automaticEssential)
        vm.send(.loadConversation(tabId: "tab-A", before: nil), intent: .automaticEssential) // dupe
        vm.send(.loadConversation(tabId: "tab-B", before: nil), intent: .automaticEssential)
        vm.send(.sync, intent: .automaticEssential)

        let queueDepthBefore = vm.pendingEssentialQueue.count
        XCTAssertEqual(queueDepthBefore, 3, "Expected 3 distinct deduped entries")

        // Simulate connect: flip state then drain (mirrors handleSnapshot)
        vm.connectionState = .connected
        vm.drainPendingEssential()

        // Queue must be empty after drain (regardless of whether transport exists)
        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "Essential queue must be empty after drainPendingEssential()")

        // No toast must have been produced during drain
        XCTAssertTrue(vm.toastMessages.isEmpty,
            "Automatic essential drain must never produce toasts")
    }

    // MARK: - Test 4: fire-and-forget while disconnected is dropped, not queued, no toast

    func testFireAndForgetWhileDisconnectedIsDroppedNoToast() {
        let vm = SessionViewModel()
        XCTAssertNotEqual(vm.connectionState, .connected)

        vm.send(.fsReadImage(filePath: "/some/path.png"), intent: .automaticFireAndForget)

        XCTAssertTrue(vm.toastMessages.isEmpty,
            "A fire-and-forget send while disconnected must not produce a toast")
        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "A fire-and-forget send while disconnected must not be enqueued")
    }

    // MARK: - Test 5: user-initiated while disconnected still toasts

    func testUserInitiatedWhileDisconnectedToasts() async {
        let vm = SessionViewModel()
        // Ensure transport == nil (default)
        XCTAssertNil(vm.transport)
        XCTAssertNotEqual(vm.connectionState, .connected)

        vm.send(.prompt(tabId: "t", text: "hello"), intent: .userInitiated)

        // Toast is appended via Task { @MainActor } -- yield to let it run
        await Task.yield()

        XCTAssertFalse(vm.toastMessages.isEmpty,
            "A user-initiated send with no transport must produce a 'Not connected' toast")
        XCTAssertTrue(
            vm.toastMessages.contains(where: { $0.title == "Not connected" }),
            "Toast title must be 'Not connected'"
        )
    }

    // MARK: - Test 6: hard disconnect clears the essential queue

    func testHardDisconnectClearsEssentialQueue() {
        let vm = SessionViewModel()
        XCTAssertNotEqual(vm.connectionState, .connected)

        // Enqueue some essential commands while disconnected
        vm.send(.loadConversation(tabId: "tab-1", before: nil), intent: .automaticEssential)
        vm.send(.sync, intent: .automaticEssential)
        XCTAssertFalse(vm.pendingEssentialQueue.isEmpty, "Pre-condition: queue is populated")

        // Hard disconnect clears the queue (via clearPendingEssential())
        vm.clearPendingEssential()

        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "clearPendingEssential() must empty the queue so stale intent doesn't replay against a new pairing")

        // Simulating a later connect must not flush anything
        vm.connectionState = .connected
        vm.drainPendingEssential() // should be a no-op

        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "Queue must remain empty after drainPendingEssential() on an already-cleared queue")
        XCTAssertTrue(vm.toastMessages.isEmpty,
            "No toasts from a no-op drain")
    }

    // MARK: - Test 7: existing runWhenConnected parity (no-regression)

    func testRunWhenConnectedParityUnchanged() {
        let vm = SessionViewModel()
        XCTAssertNotEqual(vm.connectionState, .connected)

        var ran = false
        vm.runWhenConnected { ran = true }

        // Block must NOT have run yet
        XCTAssertFalse(ran, "runWhenConnected block must not run while disconnected")
        XCTAssertEqual(vm.pendingOnConnected.count, 1, "Block must be in the pending closure queue")

        // Drain (mirrors handleSnapshot after .connected flip)
        vm.connectionState = .connected
        vm.drainPendingOnConnected()

        XCTAssertTrue(ran, "runWhenConnected block must run after drainPendingOnConnected()")
        XCTAssertTrue(vm.pendingOnConnected.isEmpty, "Closure queue must be empty after drain")

        // Essential queue is independent -- draining closures must not touch it
        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "Essential queue must be unaffected by drainPendingOnConnected()")
    }
}
