import XCTest
import CryptoKit
@testable import IonRemote

// MARK: - SendFailureRequeueTests
//
// Pins the "no silent command loss" contract: a command that fails to send
// (wedged socket, mid-reconnect teardown, timeout) is re-enqueued for the
// essential-queue flush on reconnect instead of being logged-and-lost. The
// live-log incident this guards against: a user prompt sent while the
// transport was wedged was optimistically inserted, the draft cleared, and
// the message silently never delivered.

@MainActor
final class SendFailureRequeueTests: XCTestCase {

    /// A disconnected TransportManager whose `send` always throws
    /// `.noTransportAvailable` — the exact failure shape of a mid-reconnect
    /// send.
    private func failingTransport() -> TransportManager {
        TransportManager(sharedKey: SymmetricKey(size: .bits256), deviceId: "test-device")
    }

    private func waitUntil(
        timeout: TimeInterval = 2.0,
        _ condition: @escaping @MainActor () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    // MARK: - Prompt eligibility for the essential queue

    func testPromptHasEssentialKeyUniquePerMessage() {
        let a = RemoteCommand.prompt(tabId: "t1", text: "first", clientMsgId: "msg-a")
        let b = RemoteCommand.prompt(tabId: "t1", text: "second", clientMsgId: "msg-b")
        XCTAssertEqual(a.essentialKey, "prompt:t1:msg-a")
        XCTAssertEqual(b.essentialKey, "prompt:t1:msg-b")
        XCTAssertNotEqual(a.essentialKey, b.essentialKey,
            "Two distinct prompts to the same tab must never dedupe each other in the essential queue")
    }

    // MARK: - userInitiated failure paths

    /// Transport object absent entirely (mid soft-reconnect teardown): a user
    /// prompt is queued, not dropped.
    func testUserInitiatedPromptWithNoTransportIsQueued() async {
        let vm = SessionViewModel()
        XCTAssertNil(vm.transport)

        vm.send(.prompt(tabId: "t1", text: "hello", clientMsgId: "m1"), intent: .userInitiated)

        XCTAssertEqual(vm.pendingEssentialQueue.first?.key, "prompt:t1:m1",
            "A user prompt with no transport must be enqueued for the reconnect flush, never dropped")
        await Task.yield()
        let toasted = await waitUntil { !vm.toastMessages.isEmpty }
        XCTAssertTrue(toasted, "The user must see visible feedback that the prompt was queued")
    }

    /// Transport present but the send throws (wedged/reconnecting socket) —
    /// this is the exact live-log lost-message scenario. The prompt must land
    /// in the essential queue for the reconnect flush.
    func testUserInitiatedPromptSendFailureRequeues() async {
        let vm = SessionViewModel()
        vm.transport = failingTransport()
        vm.connectionState = .connected // iOS *believes* it is connected

        vm.send(.prompt(tabId: "t1", text: "lost message", clientMsgId: "m-lost"), intent: .userInitiated)

        let requeued = await waitUntil {
            vm.pendingEssentialQueue.contains { $0.key == "prompt:t1:m-lost" }
        }
        XCTAssertTrue(requeued,
            "A user prompt whose send fails must be re-enqueued for the reconnect flush — never silently lost")
        let toasted = await waitUntil { !vm.toastMessages.isEmpty }
        XCTAssertTrue(toasted, "The failure must be visibly surfaced")
    }

    /// Non-queueable user commands (no essentialKey) still surface an error
    /// toast on failure — visible failure, not silent loss.
    func testUserInitiatedNonQueueableFailureShowsErrorToast() async {
        let vm = SessionViewModel()
        vm.transport = failingTransport()
        vm.connectionState = .connected

        vm.send(.cancel(tabId: "t1"), intent: .userInitiated)

        let toasted = await waitUntil {
            vm.toastMessages.contains { $0.style == .error }
        }
        XCTAssertTrue(toasted, "A non-queueable user command failure must show an error toast")
        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "Commands without an essential identity must not enter the queue")
    }

    // MARK: - automaticEssential failure path

    /// Connected-but-threw: the essential command is re-enqueued for the next
    /// flush instead of being logged and lost.
    func testEssentialSendFailureRequeues() async {
        let vm = SessionViewModel()
        vm.transport = failingTransport()
        vm.connectionState = .connected

        vm.send(.sync, intent: .automaticEssential)

        let requeued = await waitUntil {
            vm.pendingEssentialQueue.contains { $0.key == "sync" }
        }
        XCTAssertTrue(requeued,
            "An essential command whose send fails while 'connected' must be re-enqueued")
        XCTAssertTrue(vm.toastMessages.isEmpty, "Automatic sends never toast")
    }

    // MARK: - drain resilience

    /// Draining with a nil transport must put the batch back — the queue can
    /// carry user prompts, which have no re-triggering call site.
    func testDrainWithNilTransportRequeuesInsteadOfDropping() {
        let vm = SessionViewModel()
        vm.enqueueEssential(key: "prompt:t1:m9", command: .prompt(tabId: "t1", text: "hi", clientMsgId: "m9"))
        vm.connectionState = .connected
        XCTAssertNil(vm.transport)

        vm.drainPendingEssential()

        XCTAssertEqual(vm.pendingEssentialQueue.count, 1,
            "A drain that finds no transport must re-enqueue the batch, not drop it")
        XCTAssertEqual(vm.pendingEssentialQueue.first?.key, "prompt:t1:m9")
    }

    /// A flush send that throws re-enqueues its entry for the next snapshot's
    /// drain.
    func testDrainSendFailureRequeuesEntry() async {
        let vm = SessionViewModel()
        vm.transport = failingTransport()
        vm.connectionState = .connected
        vm.enqueueEssential(key: "prompt:t1:m10", command: .prompt(tabId: "t1", text: "hi", clientMsgId: "m10"))

        vm.drainPendingEssential()

        let requeued = await waitUntil {
            vm.pendingEssentialQueue.contains { $0.key == "prompt:t1:m10" }
        }
        XCTAssertTrue(requeued,
            "A flush send that fails must re-enqueue its entry for the next drain")
    }
}
