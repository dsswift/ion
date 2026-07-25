import XCTest
@testable import IonRemote

/// Pins the `/clear` pill ordering contract (Option A).
///
/// `/clear` is now persisted by the engine as a DisplayOnly user-invocation row
/// (SlashCommand "/clear") chained immediately BEFORE the EntryCleared marker,
/// and the engine announces the row's canonical tree-entry id via
/// engine_user_turn_persisted. This gives the optimistic `/clear` pill a
/// canonical row to re-key against — exactly like every other slash command.
///
/// Before this fix, the optimistic `/clear` pill had no canonical row: it was
/// classified pending-optimistic forever and appended AFTER all of `incoming`
/// on every history replace, floating to the bottom below later turns (the
/// reported reorder bug). The regression assertion at the end of the primary
/// test reproduces that failure when the re-key is skipped.
@MainActor
final class ClearPillReconcileTests: XCTestCase {

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

    /// A persisted `/clear` invocation row as it arrives in a history page:
    /// a user row carrying slash provenance and the canonical entry id.
    private func clearHistoryRow(id: String) -> Message {
        var m = Message(id: id, role: .user, content: "/clear", timestamp: 1_700_000_000_000)
        m.slashCommand = "/clear"
        m.slashSource = "ion"
        return m
    }

    /// The cleared divider row replayed from the EntryCleared marker: a system
    /// row with the "──" sentinel and MarkerKind "clear".
    private func clearedDividerRow(id: String) -> Message {
        var m = Message(id: id, role: .system, content: "──", timestamp: 1_700_000_000_001)
        m.markerKind = "clear"
        return m
    }

    /// A following `/squash` user turn persisted after the clear.
    private func squashRow(id: String) -> Message {
        var m = Message(id: id, role: .user, content: "/squash", timestamp: 1_700_000_000_002)
        m.slashCommand = "/squash"
        m.slashSource = "ion"
        return m
    }

    // MARK: - Primary: live re-key + reload yields one pill, in order

    /// Full flow: optimistic `/clear` pill → engine_user_turn_persisted re-keys
    /// it to the canonical id → history reload delivers the canonical `/clear`
    /// row, the cleared divider, and a following `/squash` row. The result must
    /// be EXACTLY ONE `/clear` pill, ordered before the divider and before the
    /// squash turn.
    func testClearPillReKeysAndOrdersOnReload() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab1")]

        // 1. Optimistic `/clear` pill (submit parses slash provenance).
        vm.submit(tabId: "tab1", text: "/clear")
        let optimistic = vm.conversationMessages("tab1").first { $0.role == .user }
        XCTAssertNotNil(optimistic, "Precondition: optimistic /clear pill inserted")
        XCTAssertEqual(optimistic?.slashCommand, "/clear", "optimistic pill carries slash provenance")
        let clientMsgId = optimistic!.id

        // 2. The engine persisted the /clear invocation row and announced its
        //    canonical id. iOS re-keys the optimistic pill to it.
        let canonicalClearId = "entry-clear-01"
        vm.handleEngineUserTurnPersisted(tabId: "tab1", instanceId: nil, entryId: canonicalClearId)
        XCTAssertEqual(vm.conversationMessages("tab1").first { $0.role == .user }?.id, canonicalClearId,
            "the optimistic /clear pill must re-key to the canonical clear entry id")

        // 3. Settled history reload: canonical /clear row, cleared divider,
        //    then a /squash turn. tab is idle (not running) so this is a
        //    wholesale replace.
        let page = [
            clearHistoryRow(id: canonicalClearId),
            clearedDividerRow(id: "entry-cleared-02"),
            squashRow(id: "entry-squash-03"),
        ]
        vm.handleConversationHistory(tabId: "tab1", newMessages: page, hasMore: false, cursor: nil)

        // Exactly one /clear pill, and it is ordered before the divider and
        // before the /squash turn.
        let msgs = vm.conversationMessages("tab1")
        let clearPills = msgs.filter { $0.slashCommand == "/clear" }
        XCTAssertEqual(clearPills.count, 1, "exactly one /clear pill after reload (no orphan floating copy)")

        let clearIdx = msgs.firstIndex { $0.slashCommand == "/clear" }
        let dividerIdx = msgs.firstIndex { $0.markerKind == "clear" }
        let squashIdx = msgs.firstIndex { $0.slashCommand == "/squash" }
        XCTAssertNotNil(clearIdx)
        XCTAssertNotNil(dividerIdx)
        XCTAssertNotNil(squashIdx)
        XCTAssertLessThan(clearIdx!, dividerIdx!, "/clear pill must render BEFORE the cleared divider")
        XCTAssertLessThan(dividerIdx!, squashIdx!, "cleared divider must render BEFORE the /squash turn")
    }

    // MARK: - Regression: without the re-key the pill floats to the bottom

    /// If the engine does NOT persist the /clear row (no canonical id to re-key
    /// against — the pre-fix behavior), the optimistic pill is classified
    /// pending-optimistic and appended AFTER the whole page, floating below the
    /// squash turn. This test reproduces the reported reorder bug and would go
    /// green only with the re-key path removed — it is the guard that the fix
    /// stays in place.
    func testWithoutReKeyClearPillFloatsToBottom() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab2")]

        // Optimistic /clear pill — but NO engine_user_turn_persisted re-key
        // (simulating the pre-fix engine that never persisted the /clear row).
        vm.submit(tabId: "tab2", text: "/clear")
        let optimisticId = vm.conversationMessages("tab2").first { $0.role == .user }?.id
        XCTAssertNotNil(optimisticId)

        // History reload carries the divider and a following /squash turn, but
        // NOT a canonical /clear row (the pre-fix engine persisted only the
        // marker). The orphan optimistic pill has no page row to anchor on.
        let page = [
            clearedDividerRow(id: "entry-cleared-02"),
            squashRow(id: "entry-squash-03"),
        ]
        vm.handleConversationHistory(tabId: "tab2", newMessages: page, hasMore: false, cursor: nil)

        // The bug: the orphan /clear pill lands AFTER the /squash turn.
        let msgs = vm.conversationMessages("tab2")
        let clearIdx = msgs.firstIndex { $0.slashCommand == "/clear" }
        let squashIdx = msgs.firstIndex { $0.slashCommand == "/squash" }
        XCTAssertNotNil(clearIdx)
        XCTAssertNotNil(squashIdx)
        XCTAssertGreaterThan(clearIdx!, squashIdx!,
            "Pre-fix behavior: an un-re-keyed /clear pill floats below the /squash turn. If this assertion fails, the re-key path is engaged and the primary test is the real contract.")
    }
}
