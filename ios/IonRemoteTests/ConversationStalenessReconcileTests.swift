import XCTest
@testable import IonRemote

/// Regression test for the main-conversation freeze on dropped live deltas
/// (e.g. a LAN↔relay transport switch mid-stream): the snapshot staleness
/// reconcile (v2 — tail fingerprint) must re-fetch authoritative history when
/// iOS's local tail fingerprint diverges from the desktop's, and must NOT
/// thrash when in sync.
///
/// Reverting `maybeReconcileStaleConversation` (or breaking fingerprint parity)
/// turns the heal/parity assertions red.
@MainActor
final class ConversationStalenessReconcileTests: XCTestCase {

    private func makeTab(id: String, convFingerprint: String?, status: TabStatus = .idle) -> RemoteTabState {
        var tab = RemoteTabState(
            id: id,
            title: id,
            customTitle: nil,
            status: status,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: [],
            hasEngineExtension: false
        )
        tab.convFingerprint = convFingerprint
        return tab
    }

    private func msg(id: String, role: MessageRole, content: String, toolStatus: ToolStatus? = nil) -> Message {
        Message(id: id, role: role, content: content, toolStatus: toolStatus, timestamp: 1)
    }

    // MARK: - Cross-platform parity anchor

    /// The golden string MUST match the desktop's
    /// conversation-fingerprint.test.ts "produces the pinned golden string"
    /// case byte-for-byte. If either side's algorithm changes, one of the two
    /// tests fails — that is the parity guard.
    func testFingerprintGoldenStringMatchesDesktop() {
        let vm = SessionViewModel()
        let msgs = [
            msg(id: "u1", role: .user, content: "hello"),         // 5 bytes
            msg(id: "a1", role: .assistant, content: "hi there"), // 8 bytes
            msg(id: "t1", role: .tool, content: "whatever", toolStatus: .running),
        ]
        XCTAssertEqual(vm.conversationTailFingerprint(msgs), "u1:5,a1:8,t1:tr")
    }

    /// v2: client-local roles (thinking synthesis, live-inserted system
    /// dividers) are excluded BEFORE windowing — they carry ids only one side
    /// knows, and including them made the two fingerprints diverge permanently
    /// (the heal loop that grew the transcript by one page per snapshot).
    /// Matches the desktop's "excludes client-local roles" case.
    func testFingerprintExcludesClientLocalRoles() {
        let vm = SessionViewModel()
        let persisted = [
            msg(id: "u1", role: .user, content: "hello"),
            msg(id: "a1", role: .assistant, content: "hi there"),
        ]
        let withLocal = [
            persisted[0],
            msg(id: "think-uuid", role: .thinking, content: "reasoning..."),
            msg(id: "sys-uuid", role: .system, content: "── Plan created ──"),
            persisted[1],
            msg(id: "harness-1", role: .harness, content: "Session bootstrapped"),
        ]
        XCTAssertEqual(
            vm.conversationTailFingerprint(withLocal),
            vm.conversationTailFingerprint(persisted)
        )
    }

    /// v2: tool rows key on the engine toolId so a live-streamed tool row and
    /// its history-reloaded counterpart (different row id, same toolId)
    /// produce the same token. Matches the desktop's "keys tool rows by
    /// toolId" case, golden "toolu_9:tc".
    func testFingerprintToolRowsKeyOnToolId() {
        let vm = SessionViewModel()
        var live = msg(id: "toolu_9", role: .tool, content: "x", toolStatus: .completed)
        live.toolId = "toolu_9"
        var reloaded = msg(id: "e42:1", role: .tool, content: "different content", toolStatus: .completed)
        reloaded.toolId = "toolu_9"
        XCTAssertEqual(vm.conversationTailFingerprint([live]), "toolu_9:tc")
        XCTAssertEqual(
            vm.conversationTailFingerprint([live]),
            vm.conversationTailFingerprint([reloaded])
        )
    }

    /// Pagination-safety regression for the reload-flash bug: iOS holds a
    /// paginated PAGE while the desktop holds the FULL list. When both share the
    /// same final tail, the fingerprints must be EQUAL (no total-count term), or
    /// the heal reloads on every snapshot.
    func testFingerprintPaginationSafe() {
        let vm = SessionViewModel()
        var sharedTail: [Message] = []
        for i in 0..<10 { sharedTail.append(msg(id: "tail-\(i)", role: .assistant, content: "t \(i)")) }
        var page = (0..<40).map { msg(id: "page-\($0)", role: .assistant, content: "p \($0)") }
        page.append(contentsOf: sharedTail)
        var full = (0..<490).map { msg(id: "old-\($0)", role: .assistant, content: "old \($0)") }
        full.append(contentsOf: sharedTail)
        XCTAssertEqual(vm.conversationTailFingerprint(page), vm.conversationTailFingerprint(full))
    }

    func testFingerprintUsesUTF8ByteLength() {
        let vm = SessionViewModel()
        // "é" is 1 UTF-16 unit but 2 UTF-8 bytes; "ab" is 2 bytes. Equal byte
        // length → equal fingerprint, proving byte (not UTF-16) length.
        let ascii = [msg(id: "a", role: .assistant, content: "ab")]
        let accent = [msg(id: "a", role: .assistant, content: "é")]
        XCTAssertEqual(
            vm.conversationTailFingerprint(ascii),
            vm.conversationTailFingerprint(accent)
        )
        let emoji = [msg(id: "a", role: .assistant, content: "😀")] // 4 bytes
        XCTAssertNotEqual(
            vm.conversationTailFingerprint(ascii),
            vm.conversationTailFingerprint(emoji)
        )
    }

    func testFingerprintToolStatusOnlyImmuneToTruncation() {
        let vm = SessionViewModel()
        // Desktop sees full tool content; history page truncates >2KB. Tool rows
        // are fingerprinted by status only, so the two must match (no reload loop).
        let full = [msg(id: "t1", role: .tool, content: String(repeating: "x", count: 5000), toolStatus: .completed)]
        let truncated = [msg(id: "t1", role: .tool, content: String(repeating: "x", count: 2048) + "\n... [truncated]", toolStatus: .completed)]
        XCTAssertEqual(
            vm.conversationTailFingerprint(full),
            vm.conversationTailFingerprint(truncated)
        )
    }

    // MARK: - Heal behavior

    /// Desktop fingerprint diverges from local (a dropped tool_end: desktop says
    /// completed, local still running) → heal fires (loadConversation marks the
    /// tab loading and drops the loaded mark, but preserves existing messages
    /// visible during the round-trip per the no-pre-clear invariant).
    func testHealsWhenFingerprintDiverges() {
        let vm = SessionViewModel()
        let tab = "tab-stale"
        // Local: tool still "running" (its tool_end delta was dropped).
        vm.handleConversationHistory(tabId: tab, newMessages: [msg(id: "t1", role: .tool, content: "out", toolStatus: .running)], hasMore: false, cursor: nil)
        XCTAssertTrue(vm.conversationLoaded.contains(tab))

        // Desktop snapshot fingerprint reflects the completed tool.
        let desktopFp = vm.conversationTailFingerprint([msg(id: "t1", role: .tool, content: "out", toolStatus: .completed)])
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: desktopFp))

        XCTAssertTrue(vm.loadingConversation.contains(tab), "diverged fingerprint must re-fetch history")
        XCTAssertFalse(vm.conversationLoaded.contains(tab), "re-fetch clears the loaded mark until history returns")
        // loadConversation intentionally does NOT pre-clear the transcript so the
        // user never sees a blank conversation during the round-trip. The stale
        // messages stay visible until handleConversationHistory replaces them.
        XCTAssertEqual(vm.conversationMessages(tab).count, 1, "stale transcript is preserved during the in-flight load")
    }

    /// Fingerprints match → no heal, no thrash (the in-sync streaming case).
    func testNoHealWhenFingerprintMatches() {
        let vm = SessionViewModel()
        let tab = "tab-sync"
        let msgs = [msg(id: "a1", role: .assistant, content: "hello")]
        vm.handleConversationHistory(tabId: tab, newMessages: msgs, hasMore: false, cursor: nil)
        let inSyncFp = vm.conversationTailFingerprint(msgs)

        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: inSyncFp))

        XCTAssertFalse(vm.loadingConversation.contains(tab), "in-sync tab must not re-fetch")
        XCTAssertTrue(vm.conversationLoaded.contains(tab))
        XCTAssertEqual(vm.conversationMessages(tab).count, 1, "in-sync transcript is preserved")
    }

    /// The per-tab debounce prevents a second heal within the window.
    func testDebouncePreventsImmediateSecondHeal() {
        let vm = SessionViewModel()
        let tab = "tab-debounce"
        vm.handleConversationHistory(tabId: tab, newMessages: [msg(id: "a1", role: .assistant, content: "x")], hasMore: false, cursor: nil)
        let divergedFp = vm.conversationTailFingerprint([msg(id: "a1", role: .assistant, content: "x GREW LONGER")])

        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: divergedFp))
        XCTAssertTrue(vm.loadingConversation.contains(tab))

        // History lands (clears loading) so the in-flight guard doesn't mask the debounce.
        vm.handleConversationHistory(tabId: tab, newMessages: [msg(id: "a1", role: .assistant, content: "x")], hasMore: false, cursor: nil)
        XCTAssertFalse(vm.loadingConversation.contains(tab))

        // Immediately-following snapshot, still diverged: debounce suppresses it.
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: divergedFp))
        XCTAssertFalse(vm.loadingConversation.contains(tab), "debounce must suppress the immediate second heal")
    }

    /// While a load is already in flight, no duplicate heal is issued.
    func testNoHealWhileLoadInFlight() {
        let vm = SessionViewModel()
        let tab = "tab-inflight"
        vm.handleConversationHistory(tabId: tab, newMessages: [msg(id: "a1", role: .assistant, content: "x")], hasMore: false, cursor: nil)
        vm.loadingConversation.insert(tab)
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: "different|n=99"))
        XCTAssertEqual(vm.conversationMessages(tab).count, 1, "must not pile a second re-fetch onto an in-flight load")
    }

    /// Empty/nil desktop fingerprint (cold-start tab) → nothing to compare, no heal.
    func testNoHealWithoutDesktopFingerprint() {
        let vm = SessionViewModel()
        let tab = "tab-cold"
        vm.handleConversationHistory(tabId: tab, newMessages: [msg(id: "a1", role: .assistant, content: "x")], hasMore: false, cursor: nil)
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: ""))
        XCTAssertFalse(vm.loadingConversation.contains(tab))
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: nil))
        XCTAssertFalse(vm.loadingConversation.contains(tab))
    }

    // MARK: - Streaming gate (new)

    /// While a tab is actively streaming (.running), reconcile must be suppressed
    /// even when the fingerprint diverges. Firing loadConversation mid-stream
    /// would wipe live messages and cause a 1-2s blank flicker on every snapshot.
    ///
    /// Regression anchor: reverting the `tab.status != .running` guard in
    /// maybeReconcileStaleConversation turns this test red.
    func testNoHealWhileTabIsRunning() {
        let vm = SessionViewModel()
        let tab = "tab-running"
        // Load a message so there is a local fingerprint to compare.
        vm.handleConversationHistory(tabId: tab, newMessages: [msg(id: "a1", role: .assistant, content: "partial")], hasMore: false, cursor: nil)
        XCTAssertTrue(vm.conversationLoaded.contains(tab))

        // Desktop fingerprint is ahead (final assistant message arrived on desktop
        // but iOS has only the partial delta).
        let desktopFp = vm.conversationTailFingerprint([msg(id: "a1", role: .assistant, content: "partial complete")])

        // Tab is still .running — reconcile must be suppressed.
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: desktopFp, status: .running))

        XCTAssertFalse(vm.loadingConversation.contains(tab), "reconcile must not fire while tab.status == .running")
        XCTAssertTrue(vm.conversationLoaded.contains(tab), "loaded mark must be preserved")
        XCTAssertEqual(vm.conversationMessages(tab).count, 1, "live messages must not be wiped")

        // .connecting is the other streaming state — also suppressed.
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: desktopFp, status: .connecting))
        XCTAssertFalse(vm.loadingConversation.contains(tab), "reconcile must not fire while tab.status == .connecting")
    }

    // MARK: - Reconnect bypass

    /// On the first snapshot after a (re)connect, the running-status suppression
    /// guard must be bypassed: iOS has no in-flight stream during a reconnect gap
    /// and a diverged fingerprint means genuinely stale content that needs an
    /// immediate reload regardless of tab.status.
    ///
    /// Regression anchor: reverting the `isReconnectSnapshot` bypass in
    /// maybeReconcileStaleConversation while `isReconnectSnapshot == true` turns
    /// this test red.
    func testReconnectSnapshotBypassesRunningGuard() {
        let vm = SessionViewModel()
        let tab = "tab-reconnect-running"

        // Load some messages so iOS has a local fingerprint.
        vm.handleConversationHistory(
            tabId: tab,
            newMessages: [msg(id: "a1", role: .assistant, content: "old content")],
            hasMore: false,
            cursor: nil
        )
        XCTAssertTrue(vm.conversationLoaded.contains(tab))

        // Desktop fingerprint has advanced (clear + new session ran during the gap).
        let desktopFp = vm.conversationTailFingerprint([
            msg(id: "a2", role: .user, content: "post-clear prompt"),
        ])
        XCTAssertNotEqual(desktopFp, vm.conversationTailFingerprint([msg(id: "a1", role: .assistant, content: "old content")]))

        // First: confirm the normal guard suppresses when NOT a reconnect snapshot.
        vm.isReconnectSnapshot = false
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: desktopFp, status: .running))
        XCTAssertFalse(vm.loadingConversation.contains(tab),
            "normal streaming case: reconcile must be suppressed while tab.status == .running")

        // Now simulate the reconnect: set the flag and call again.
        // (Reset debounce so the second call isn't blocked by it.)
        vm.lastConversationReconcileAt.removeValue(forKey: tab)
        vm.isReconnectSnapshot = true
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: desktopFp, status: .running))
        XCTAssertTrue(vm.loadingConversation.contains(tab),
            "reconnect snapshot: reconcile must fire even while tab.status == .running (iOS missed events during gap)")
        XCTAssertFalse(vm.conversationLoaded.contains(tab),
            "reconnect reload must clear the loaded mark")
    }

    /// On a reconnect, the per-tab debounce must also be bypassed so the
    /// reload fires on the first snapshot and is not deferred by up to 4 s.
    func testReconnectSnapshotBypassesDebounce() {
        let vm = SessionViewModel()
        let tab = "tab-reconnect-debounce"

        // Local message: "stale" (5 bytes). Desktop message: "fresh content" (13
        // bytes). Byte lengths differ so fingerprints differ → the heal guard passes.
        vm.handleConversationHistory(
            tabId: tab,
            newMessages: [msg(id: "a1", role: .assistant, content: "stale")],
            hasMore: false,
            cursor: nil
        )
        let desktopFp = vm.conversationTailFingerprint([msg(id: "a1", role: .assistant, content: "fresh content")])
        XCTAssertNotEqual(
            vm.conversationTailFingerprint(vm.conversationMessages(tab)),
            desktopFp,
            "precondition: fingerprints must differ for the debounce test to be meaningful"
        )

        // Seed the debounce timer as if a reconcile fired just now.
        vm.lastConversationReconcileAt[tab] = Date()

        // Normal case: debounce suppresses.
        vm.isReconnectSnapshot = false
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: desktopFp))
        XCTAssertFalse(vm.loadingConversation.contains(tab),
            "debounce must suppress a second heal within the window (normal case)")

        // Reconnect case: debounce is bypassed.
        vm.isReconnectSnapshot = true
        vm.maybeReconcileStaleConversation(tab: makeTab(id: tab, convFingerprint: desktopFp))
        XCTAssertTrue(vm.loadingConversation.contains(tab),
            "reconnect snapshot must bypass the debounce and fire immediately")
    }

    /// Flapping guard: the reconnect bypass may be granted at most once per
    /// reconnectReloadDebounce. A rapidly reconnecting transport would otherwise
    /// re-fire loadConversation for every diverged tab on every reconnect,
    /// flooding the desktop (a relay-wedge trigger). Only the first reconnect in
    /// the window bypasses the per-tab debounce; the rest fall back to it.
    /// Reverting allowReconnectReconcileBypass turns this red.
    func testReconnectBypassIsRateLimitedUnderFlapping() {
        let vm = SessionViewModel()
        let t0 = Date()

        // First reconnect in a quiet period → bypass granted.
        XCTAssertTrue(vm.allowReconnectReconcileBypass(now: t0),
            "first reconnect must be granted the reconcile bypass")

        // A reconnect inside the window (flapping) → bypass denied.
        let within = t0.addingTimeInterval(SessionViewModel.reconnectReloadDebounce - 1)
        XCTAssertFalse(vm.allowReconnectReconcileBypass(now: within),
            "a reconnect inside the debounce window must NOT re-grant the bypass")

        // A genuine reconnect after the window elapses → granted again.
        let after = t0.addingTimeInterval(SessionViewModel.reconnectReloadDebounce + 0.1)
        XCTAssertTrue(vm.allowReconnectReconcileBypass(now: after),
            "a reconnect after the window may bypass again")
    }

    /// One-shot post-run heal: handleTabStatus(.idle) after .running must fire
    /// exactly one reconcile when the fingerprint diverges, and a second .idle
    /// call (already idle) must not fire a second load.
    func testPostRunHealFiresOnceOnRunningToIdle() {
        let vm = SessionViewModel()
        let tabId = "tab-post-run"

        // Set up a loaded tab with a stale local message.
        vm.handleConversationHistory(tabId: tabId, newMessages: [msg(id: "a1", role: .assistant, content: "partial")], hasMore: false, cursor: nil)
        XCTAssertTrue(vm.conversationLoaded.contains(tabId))

        // Register the tab in vm.tabs as .running so handleTabStatus can find it.
        var runningTab = RemoteTabState(
            id: tabId,
            title: tabId,
            customTitle: nil,
            status: .running,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: [],
            hasEngineExtension: false
        )
        // Desktop fingerprint diverges (final message differs from local partial).
        runningTab.convFingerprint = vm.conversationTailFingerprint([msg(id: "a1", role: .assistant, content: "partial complete")])
        vm.tabs.append(runningTab)

        // Transition .running → .idle: one-shot heal should fire.
        vm.handleTabStatus(tabId: tabId, status: .idle)

        XCTAssertTrue(vm.loadingConversation.contains(tabId), "post-run heal must re-fetch history when fingerprint diverges")

        // Simulate history landing so we can test the second call.
        vm.handleConversationHistory(tabId: tabId, newMessages: [msg(id: "a1", role: .assistant, content: "partial")], hasMore: false, cursor: nil)
        XCTAssertFalse(vm.loadingConversation.contains(tabId))

        // Second .idle call (idle → idle — previousStatus captured before update
        // is now .idle, not .running): no second heal within the debounce window.
        vm.handleTabStatus(tabId: tabId, status: .idle)
        XCTAssertFalse(vm.loadingConversation.contains(tabId), "second idle transition must not fire a second load")
    }
}
