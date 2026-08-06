import XCTest
@testable import IonRemote

/// RC4 + RC5 pins for the conversation-load gating that removed the
/// "Loading conversation…" spinner from a brand-new, history-less tab.
///
/// Two independent defects fed the same symptom — a `desktop_load_conversation`
/// the desktop coalesced and (pre-fix) never answered, leaving the client's
/// `loadingConversation` flag set until its own 5s retry timer fired:
///
///   RC4 — ConversationView fired the load from two `.task` blocks on every
///         appear, guarded by `engineMsgs.isEmpty`, which is permanently true
///         for a conversation with no messages.
///   RC5 — handleSnapshot started loads in its tab loop and then, twenty-odd
///         lines later, re-sent every entry of the live `loadingConversation`
///         set — including the ones it had just added microseconds earlier.
@MainActor
final class ConversationLoadGateTests: XCTestCase {

    // MARK: - RC4: loadConversationIfNeeded

    func testSkipsWhenConversationAlreadyLoaded() {
        let vm = SessionViewModel()
        let tabId = "tab-loaded"
        vm.conversationLoaded.insert(tabId)

        vm.loadConversationIfNeeded(tabId: tabId)

        // A loaded tab must not be re-requested on a view appear. The old
        // `engineMsgs.isEmpty` guard re-asked forever on an empty conversation,
        // because "no rows" and "never loaded" are not the same question.
        XCTAssertFalse(vm.loadingConversation.contains(tabId),
            "an already-loaded tab must not start another history load")
        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "no load_conversation command may be issued for an already-loaded tab")
    }

    func testSkipsWhenLoadAlreadyInFlight() {
        let vm = SessionViewModel()
        let tabId = "tab-inflight"
        vm.loadingConversation.insert(tabId)

        vm.loadConversationIfNeeded(tabId: tabId)

        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "a load already in flight must not be duplicated by a view appear")
    }

    func testIssuesLoadWhenNeverLoaded() {
        let vm = SessionViewModel()
        let tabId = "tab-fresh"

        vm.loadConversationIfNeeded(tabId: tabId)

        XCTAssertTrue(vm.loadingConversation.contains(tabId),
            "a never-loaded tab must actually fetch history")
        XCTAssertEqual(vm.pendingEssentialQueue.first?.key, "loadConversation:\(tabId)")

        vm.cancelLoadTimer(tabId: tabId)  // don't outlive the test
    }

    func testEmptyConversationCountsAsLoaded() {
        let vm = SessionViewModel()
        let tabId = "tab-empty"

        // Exactly the reported case: history arrives and is empty. The tab is
        // now loaded even though it renders zero rows, so a subsequent view
        // appear must be silent — this is the spinner that used to persist.
        vm.handleConversationHistory(tabId: tabId, newMessages: [], hasMore: false, cursor: nil)
        XCTAssertTrue(vm.conversationLoaded.contains(tabId), "precondition: empty history marks loaded")
        vm.pendingEssentialQueue.removeAll()

        vm.loadConversationIfNeeded(tabId: tabId)

        XCTAssertTrue(vm.pendingEssentialQueue.isEmpty,
            "an empty-but-loaded conversation must not re-request history on appear")
        XCTAssertFalse(vm.loadingConversation.contains(tabId),
            "no spinner state may be set for a conversation that is already loaded and empty")
    }

    // MARK: - RC5: the snapshot resend set

    func testResendExcludesLoadsStartedByThisSnapshot() {
        // The snapshot's tab loop started "tab-new" during this pass; nothing
        // was in flight beforehand. Resending it would duplicate a command
        // already on the wire, with the same cursor, inside the desktop's 1s
        // coalesce window.
        let resend = SessionViewModel.conversationLoadsToResend(
            inFlightBefore: [],
            currentlyLoading: ["tab-new"],
        )
        XCTAssertTrue(resend.isEmpty,
            "a load started by this snapshot must never be resent by the same snapshot")
    }

    func testResendIncludesLoadsInFlightFromAPreviousPass() {
        // The legitimate case the resend loop exists for: a load issued before
        // this snapshot is still outstanding, so it may have been dropped in a
        // transport gap and must be re-driven.
        let resend = SessionViewModel.conversationLoadsToResend(
            inFlightBefore: ["tab-old"],
            currentlyLoading: ["tab-old"],
        )
        XCTAssertEqual(resend, ["tab-old"])
    }

    func testResendMixesCorrectlyAndDropsSettledLoads() {
        let resend = SessionViewModel.conversationLoadsToResend(
            // "tab-settled" was in flight before but its history has since
            // arrived, so it is no longer loading — nothing to re-drive.
            inFlightBefore: ["tab-old", "tab-settled"],
            currentlyLoading: ["tab-old", "tab-new"],
        )
        XCTAssertEqual(resend, ["tab-old"],
            "resend only the loads that were in flight before AND are still in flight")
    }
}
