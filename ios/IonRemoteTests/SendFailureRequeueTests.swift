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

    // MARK: - One-shot view request keys (WI-2)
    //
    // FileExplorerView / GitPaneView / GitGraphListView / GitChangesListView
    // fire these once per appear/refresh/load-more with no re-triggering call
    // site. Pre-fix they had no essentialKey, so a send failure during a
    // transport gap dropped them permanently ("user command send failed, not
    // queueable" in the live logs). These tests pin their queue identity.

    func testOneShotViewCommandsHaveEssentialKeys() {
        XCTAssertEqual(
            RemoteCommand.fsListDir(directory: "/repo", includeHidden: false).essentialKey,
            "fsListDir:/repo:false")
        XCTAssertEqual(
            RemoteCommand.fsListDir(directory: "/repo", includeHidden: true).essentialKey,
            "fsListDir:/repo:true")
        XCTAssertEqual(
            RemoteCommand.gitGraph(directory: "/repo", skip: nil, limit: nil).essentialKey,
            "gitGraph:/repo:0:0")
        XCTAssertEqual(
            RemoteCommand.gitDiff(directory: "/repo", path: "src/a.txt", staged: true).essentialKey,
            "gitDiff:/repo:src/a.txt:true")
        XCTAssertEqual(
            RemoteCommand.gitDiff(directory: "/repo", path: "src/a.txt", staged: false).essentialKey,
            "gitDiff:/repo:src/a.txt:false")
        XCTAssertEqual(
            RemoteCommand.gitCommitFiles(directory: "/repo", hash: "abc1234").essentialKey,
            "gitCommitFiles:/repo:abc1234")
    }

    func testGitGraphPaginationPagesProduceDistinctKeys() {
        let page1 = RemoteCommand.gitGraph(directory: "/repo", skip: 0, limit: 100)
        let page2 = RemoteCommand.gitGraph(directory: "/repo", skip: 100, limit: 100)
        XCTAssertNotEqual(page1.essentialKey, page2.essentialKey,
            "A load-more gitGraph for a later page must never dedupe against page 1 in the essential queue")
    }

    /// The request* wrappers send with `.automaticEssential`: while
    /// disconnected the command defers to the essential queue (no toast, no
    /// drop). Pre-fix they sent `.userInitiated` with no essentialKey, so a
    /// nil transport dropped them with an error toast — this test fails there.
    func testOneShotViewRequestsDeferToEssentialQueueWhileDisconnected() {
        let vm = SessionViewModel()
        XCTAssertNil(vm.transport)
        XCTAssertNotEqual(vm.connectionState, .connected)

        vm.requestFsListDir(directory: "/repo")
        vm.requestGitGraph(directory: "/repo")
        vm.requestGitDiff(directory: "/repo", path: "f.txt", staged: false)
        vm.requestGitCommitFiles(directory: "/repo", hash: "deadbee")

        let keys = Set(vm.pendingEssentialQueue.map(\.key))
        XCTAssertTrue(keys.contains("fsListDir:/repo:false"),
            "fsListDir must defer to the essential queue while disconnected")
        XCTAssertTrue(keys.contains("gitGraph:/repo:0:0"),
            "gitGraph must defer to the essential queue while disconnected")
        XCTAssertTrue(keys.contains("gitDiff:/repo:f.txt:false"),
            "gitDiff must defer to the essential queue while disconnected")
        XCTAssertTrue(keys.contains("gitCommitFiles:/repo:deadbee"),
            "gitCommitFiles must defer to the essential queue while disconnected")
        XCTAssertTrue(vm.toastMessages.isEmpty,
            "Automatic essential deferral must never toast")
    }

    /// Transport nil while connectionState still reads .connected (soft
    /// reconnect teardown window — the exact live-log
    /// "essential not connected deferring" with status=connected case): the
    /// essential send must defer to the queue, never drop.
    func testEssentialWithNilTransportWhileConnectedDefers() {
        let vm = SessionViewModel()
        vm.connectionState = .connected
        XCTAssertNil(vm.transport)

        vm.requestGitGraph(directory: "/repo", skip: 100, limit: 100)

        XCTAssertEqual(vm.pendingEssentialQueue.first?.key, "gitGraph:/repo:100:100",
            "connectionState == .connected with a nil transport must defer the essential command to the queue")
        XCTAssertTrue(vm.toastMessages.isEmpty, "Automatic sends never toast")
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
