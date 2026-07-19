import XCTest
@testable import IonRemote

/// desktop_tab_meta volatile conversation fields (B6-1 lockstep).
///
/// The desktop's snapshot poll gate no longer re-ships the full snapshot when
/// only the per-delta conversation fields (convFingerprint / lastActivityAt /
/// lastMessage / messageCount) tick; the fresh values ride a lightweight
/// desktop_tab_meta delta instead. iOS must decode the new optional fields
/// (additive — absent keys decode as nil, so a legacy cost-only tab_meta from
/// an older desktop still works), merge them into the tab state, and feed the
/// fresh convFingerprint to the staleness heal
/// (maybeReconcileStaleConversation) that previously only the snapshot fed.
///
/// Red on unfixed code: the decode test fails to find the new fields (enum
/// case lacked them), and the heal test never fires loadConversation because
/// handleTabMeta neither stored the fingerprint nor ran the reconcile.
@MainActor
final class TabMetaVolatileFieldsTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Decode

    func testDecodeTabMetaWithVolatileFields() throws {
        let json = """
        {"type":"desktop_tab_meta","tabId":"t1","convFingerprint":"a1:5,a2:8","lastActivityAt":1700000000123,"lastMessage":"latest reply","messageCount":7}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabMeta(let tabId, let title, let cost, let groupId, let fp, let activity, let lastMessage, let count) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(title)
            XCTAssertNil(cost)
            XCTAssertNil(groupId)
            XCTAssertEqual(fp, "a1:5,a2:8")
            XCTAssertEqual(activity, 1_700_000_000_123)
            XCTAssertEqual(lastMessage, "latest reply")
            XCTAssertEqual(count, 7)
        } else {
            XCTFail("Expected tabMeta, got \(event)")
        }
    }

    /// Legacy cost-only tab_meta (older desktop / the event-wiring cost path)
    /// must still decode — the new fields are additive and absent keys are nil.
    func testDecodeLegacyCostOnlyTabMeta() throws {
        let json = """
        {"type":"desktop_tab_meta","tabId":"t1","totalCostUsd":0.42}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabMeta(let tabId, _, let cost, _, let fp, let activity, let lastMessage, let count) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(cost, 0.42)
            XCTAssertNil(fp)
            XCTAssertNil(activity)
            XCTAssertNil(lastMessage)
            XCTAssertNil(count)
        } else {
            XCTFail("Expected tabMeta, got \(event)")
        }
    }

    /// Round-trip: encode carries the volatile fields so the diagnostic /
    /// fixture paths that re-encode events preserve them.
    func testEncodeDecodeRoundTripVolatileFields() throws {
        let original = RemoteEvent.tabMeta(tabId: "t9", title: nil, totalCostUsd: nil, groupId: nil, convFingerprint: "x1:2", lastActivityAt: 42, lastMessage: "hi", messageCount: 3)
        let data = try JSONEncoder().encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .tabMeta(let tabId, _, _, _, let fp, let activity, let lastMessage, let count) = decoded {
            XCTAssertEqual(tabId, "t9")
            XCTAssertEqual(fp, "x1:2")
            XCTAssertEqual(activity, 42)
            XCTAssertEqual(lastMessage, "hi")
            XCTAssertEqual(count, 3)
        } else {
            XCTFail("Expected tabMeta, got \(decoded)")
        }
    }

    // MARK: - Handler merge

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

    func testHandleTabMetaMergesVolatileFieldsIntoTabState() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t1")]

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: nil, groupId: nil, convFingerprint: "a1:5", lastActivityAt: 1234, lastMessage: "preview", messageCount: 9)

        let tab = vm.tabs[0]
        XCTAssertEqual(tab.convFingerprint, "a1:5")
        XCTAssertEqual(tab.lastActivityAt, 1234)
        XCTAssertEqual(tab.lastMessage, "preview")
        XCTAssertEqual(tab.messageCount, 9)
    }

    /// Legacy behavior preserved: a cost-only delta still applies cost and
    /// leaves the volatile fields untouched.
    func testHandleTabMetaLegacyCostOnlyStillWorks() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "t1")
        tab.convFingerprint = "keep-me"
        vm.tabs = [tab]

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: 0.5, groupId: nil)

        XCTAssertEqual(vm.tabs[0].runCostUsd, 0.5)
        XCTAssertEqual(vm.tabs[0].totalCostUsd, 0.5)
        XCTAssertEqual(vm.tabs[0].convFingerprint, "keep-me", "absent volatile fields must not clobber existing state")
    }

    // MARK: - Heal trigger

    /// The heal logic that consumes convFingerprint must see the fresh value:
    /// a tab_meta fingerprint that diverges from the local tail fires the same
    /// reconcile the snapshot path fires (loadConversation re-fetch).
    func testFreshFingerprintViaTabMetaTriggersHeal() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t1")]
        // Local transcript loaded with a stale tail (tool stuck running).
        vm.handleConversationHistory(
            tabId: "t1",
            newMessages: [Message(id: "m1", role: .tool, content: "out", toolStatus: .running, timestamp: 1)],
            hasMore: false,
            cursor: nil
        )
        XCTAssertTrue(vm.conversationLoaded.contains("t1"))

        // Desktop's poll-tick tab_meta carries the fingerprint of the settled
        // tool (completed) — diverged from the local running tail.
        let desktopFp = vm.conversationTailFingerprint(
            [Message(id: "m1", role: .tool, content: "out", toolStatus: .completed, timestamp: 1)]
        )
        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: nil, groupId: nil, convFingerprint: desktopFp)

        XCTAssertTrue(vm.loadingConversation.contains("t1"), "diverged tab_meta fingerprint must re-fetch history (heal)")
    }

    /// In-sync fingerprint via tab_meta must NOT thrash a reload.
    func testInSyncFingerprintViaTabMetaDoesNotHeal() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t1")]
        let msgs = [Message(id: "a1", role: .assistant, content: "hello", timestamp: 1)]
        vm.handleConversationHistory(tabId: "t1", newMessages: msgs, hasMore: false, cursor: nil)
        let inSyncFp = vm.conversationTailFingerprint(msgs)

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: nil, groupId: nil, convFingerprint: inSyncFp)

        XCTAssertFalse(vm.loadingConversation.contains("t1"), "in-sync fingerprint must not re-fetch")
        XCTAssertTrue(vm.conversationLoaded.contains("t1"))
    }
}
