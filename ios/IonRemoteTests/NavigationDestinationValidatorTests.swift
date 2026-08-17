import XCTest
@testable import IonRemote

/// Tests for stale-navigation-destination handling.
///
/// Production failure: a conversation closed on the desktop is removed from
/// `viewModel.tabs`, but nothing revalidated the navigation state pointing at
/// it. `destinationView` rendered `ConversationView` for an id that no longer
/// resolved, so every derived value degraded through optional chaining and the
/// user got an untitled, message-less shell that looked like a real-but-broken
/// conversation. Recovering meant backing out to the list and re-finding the
/// conversation by hand.
final class NavigationDestinationValidatorTests: XCTestCase {

    // MARK: - Classification

    func testPresentTabIsValid() {
        let outcome = NavigationDestinationValidator.classify(
            tabId: "tab-1",
            knownTabIds: ["tab-1", "tab-2"],
            hasAppliedTabSnapshot: true
        )
        XCTAssertEqual(outcome, .valid)
    }

    /// The core fix: after a snapshot has landed, a missing tab is a closed tab.
    func testMissingTabAfterSnapshotIsStale() {
        let outcome = NavigationDestinationValidator.classify(
            tabId: "tab-closed",
            knownTabIds: ["tab-1", "tab-2"],
            hasAppliedTabSnapshot: true
        )
        XCTAssertEqual(outcome, .stale)
    }

    /// The race this design exists to avoid. On a cold launch the navigation
    /// stack can restore before the first snapshot arrives, so `knownTabIds` is
    /// legitimately empty. Treating that as stale would eject the user from a
    /// live conversation — a worse bug than the one being fixed, and visually
    /// identical to it.
    func testMissingTabBeforeSnapshotIsNotStale() {
        let outcome = NavigationDestinationValidator.classify(
            tabId: "tab-1",
            knownTabIds: [],
            hasAppliedTabSnapshot: false
        )
        XCTAssertEqual(outcome, .unresolvedAwaitingSnapshot)
        XCTAssertNotEqual(outcome, .stale)
    }

    /// An empty tab list IS authoritative once a snapshot has been applied: the
    /// desktop can legitimately have zero tabs open.
    func testEmptyTabListAfterSnapshotIsStale() {
        let outcome = NavigationDestinationValidator.classify(
            tabId: "tab-1",
            knownTabIds: [],
            hasAppliedTabSnapshot: true
        )
        XCTAssertEqual(outcome, .stale)
    }

    /// A present tab is valid even pre-snapshot (e.g. seeded by a live
    /// tabCreated event), so the gate never blocks a legitimate destination.
    func testPresentTabIsValidEvenBeforeSnapshot() {
        let outcome = NavigationDestinationValidator.classify(
            tabId: "tab-1",
            knownTabIds: ["tab-1"],
            hasAppliedTabSnapshot: false
        )
        XCTAssertEqual(outcome, .valid)
    }

    func testOutcomeLogValuesAreDistinct() {
        let values = [
            NavigationDestinationValidator.Outcome.valid.logValue,
            NavigationDestinationValidator.Outcome.unresolvedAwaitingSnapshot.logValue,
            NavigationDestinationValidator.Outcome.stale.logValue
        ]
        XCTAssertEqual(Set(values).count, 3)
        for value in values { XCTAssertFalse(value.isEmpty) }
    }

    // MARK: - Stack pruning

    func testPruneKeepsAStackOfLiveTabs() {
        let result = NavigationDestinationValidator.prune(
            stack: ["tab-1"],
            knownTabIds: ["tab-1", "tab-2"],
            hasAppliedTabSnapshot: true
        )
        XCTAssertEqual(result.stack, ["tab-1"])
        XCTAssertTrue(result.dropped.isEmpty)
    }

    /// The exact reported scenario: one conversation pushed, then closed on the
    /// desktop. The stack empties, which returns the user to the tab list.
    func testPruneEmptiesStackWhenTheOpenConversationIsClosed() {
        let result = NavigationDestinationValidator.prune(
            stack: ["tab-closed"],
            knownTabIds: ["tab-1"],
            hasAppliedTabSnapshot: true
        )
        XCTAssertEqual(result.stack, [])
        XCTAssertEqual(result.dropped, ["tab-closed"])
    }

    func testPruneIsANoOpBeforeTheFirstSnapshot() {
        let result = NavigationDestinationValidator.prune(
            stack: ["tab-1"],
            knownTabIds: [],
            hasAppliedTabSnapshot: false
        )
        XCTAssertEqual(result.stack, ["tab-1"], "must not pop before a snapshot proves absence")
        XCTAssertTrue(result.dropped.isEmpty)
    }

    /// Truncates at the first stale entry rather than filtering: entries above a
    /// dropped conversation were reached *through* it, so keeping them would
    /// leave the user somewhere they could not have navigated to.
    func testPruneTruncatesAtTheFirstStaleEntry() {
        let result = NavigationDestinationValidator.prune(
            stack: ["tab-live", "tab-closed", "tab-live-2"],
            knownTabIds: ["tab-live", "tab-live-2"],
            hasAppliedTabSnapshot: true
        )
        XCTAssertEqual(result.stack, ["tab-live"])
        XCTAssertEqual(result.dropped, ["tab-closed", "tab-live-2"])
    }

    func testPruneHandlesAnEmptyStack() {
        let result = NavigationDestinationValidator.prune(
            stack: [],
            knownTabIds: [],
            hasAppliedTabSnapshot: true
        )
        XCTAssertEqual(result.stack, [])
        XCTAssertTrue(result.dropped.isEmpty)
    }
}

/// The view-model half of the contract: closing a tab must make its id absent
/// from `tabIds` (which is what the pruning `onChange` observes), and the
/// snapshot flag must start false so the pre-snapshot gate holds.
final class StaleNavigationViewModelTests: XCTestCase {

    @MainActor
    func testSnapshotFlagStartsFalse() {
        let vm = SessionViewModel()
        XCTAssertFalse(
            vm.hasAppliedTabSnapshot,
            "a fresh launch has not been told the tab list, so absence proves nothing"
        )
    }

    @MainActor
    func testHandleTabClosedRemovesTheIdThatDrivesPruning() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-1"), makeTab(id: "tab-2")]
        vm.tabIds = ["tab-1", "tab-2"]
        vm.hasAppliedTabSnapshot = true

        vm.handleTabClosed(tabId: "tab-1")

        XCTAssertFalse(vm.tabIds.contains("tab-1"))
        XCTAssertNil(vm.tab(for: "tab-1"))
        // With the id gone and a snapshot applied, the destination is stale —
        // this is the state the view's onChange(of: tabIds) reacts to.
        XCTAssertEqual(
            NavigationDestinationValidator.classify(
                tabId: "tab-1",
                knownTabIds: vm.tabIds,
                hasAppliedTabSnapshot: vm.hasAppliedTabSnapshot
            ),
            .stale
        )
        // The surviving tab must be unaffected.
        XCTAssertEqual(
            NavigationDestinationValidator.classify(
                tabId: "tab-2",
                knownTabIds: vm.tabIds,
                hasAppliedTabSnapshot: vm.hasAppliedTabSnapshot
            ),
            .valid
        )
    }

    private func makeTab(id: String) -> RemoteTabState {
        RemoteTabState(
            id: id, title: id, customTitle: nil, status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )
    }
}
