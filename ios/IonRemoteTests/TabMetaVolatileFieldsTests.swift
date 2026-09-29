import XCTest
@testable import IonRemote

/// desktop_tab_meta volatile conversation fields (B6-1 lockstep).
///
/// The desktop's snapshot poll gate no longer re-ships the full snapshot when
/// only the per-delta conversation fields (lastActivityAt / lastMessage /
/// messageCount) tick; the fresh values ride a lightweight desktop_tab_meta
/// delta instead. iOS must decode the optional fields (additive — absent keys
/// decode as nil, so a legacy cost-only tab_meta still works) and merge them
/// into the tab state.
///
/// pillColor coverage (below, "Pill color" section) pins the same
/// additive/no-clobber contract for the desktop's `desktop_set_pill_color`
/// ack, which flows back through this same delta so the tab row picks it up
/// without a full snapshot reship.
@MainActor
final class TabMetaVolatileFieldsTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Decode

    func testDecodeTabMetaWithVolatileFields() throws {
        let json = """
        {"type":"desktop_tab_meta","tabId":"t1","lastActivityAt":1700000000123,"lastMessageAt":1700000000100,"lastMessage":"latest reply","messageCount":7}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabMeta(let tabId, let title, let cost, let activity, let lastMessageAt, let lastMessage, let count, let pillColor) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(title)
            XCTAssertNil(cost)
            XCTAssertEqual(activity, 1_700_000_000_123)
            // The honest turn boundary rides its own field: a client pricing a
            // prompt cache cannot use the activity clock, which reconnects and
            // status re-emissions also stamp.
            XCTAssertEqual(lastMessageAt, 1_700_000_000_100)
            XCTAssertEqual(lastMessage, "latest reply")
            XCTAssertEqual(count, 7)
            XCTAssertNil(pillColor)
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
        if case .tabMeta(let tabId, _, let cost, let activity, let lastMessageAt, let lastMessage, let count, let pillColor) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(cost, 0.42)
            XCTAssertNil(activity)
            XCTAssertNil(lastMessageAt)
            XCTAssertNil(lastMessage)
            XCTAssertNil(count)
            XCTAssertNil(pillColor)
        } else {
            XCTFail("Expected tabMeta, got \(event)")
        }
    }

    /// Round-trip: encode carries the volatile fields so the diagnostic /
    /// fixture paths that re-encode events preserve them.
    func testEncodeDecodeRoundTripVolatileFields() throws {
        let original = RemoteEvent.tabMeta(tabId: "t9", title: nil, totalCostUsd: nil, lastActivityAt: 42, lastMessageAt: 41, lastMessage: "hi", messageCount: 3, pillColor: nil)
        let data = try JSONEncoder().encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .tabMeta(let tabId, _, _, let activity, let lastMessageAt, let lastMessage, let count, _) = decoded {
            XCTAssertEqual(tabId, "t9")
            XCTAssertEqual(activity, 42)
            XCTAssertEqual(lastMessageAt, 41)
            XCTAssertEqual(lastMessage, "hi")
            XCTAssertEqual(count, 3)
        } else {
            XCTFail("Expected tabMeta, got \(decoded)")
        }
    }

    // MARK: - Pill color (decode)

    /// desktop_tab_meta carrying pillColor must decode it.
    /// Additive — absent on legacy (cost-only) tab_meta deltas.
    func testDecodeTabMetaWithPillColor() throws {
        let json = """
        {"type":"desktop_tab_meta","tabId":"t1","pillColor":"#f08c4a"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .tabMeta(let tabId, _, _, _, _, _, _, let pillColor) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(pillColor, "#f08c4a")
        } else {
            XCTFail("Expected tabMeta, got \(event)")
        }
    }

    /// Round-trip: encode/decode preserves pillColor.
    func testEncodeDecodeRoundTripPillColor() throws {
        let original = RemoteEvent.tabMeta(tabId: "t9", title: nil, totalCostUsd: nil, lastActivityAt: nil, lastMessageAt: nil, lastMessage: nil, messageCount: nil, pillColor: "#4ece78")
        let data = try JSONEncoder().encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .tabMeta(let tabId, _, _, _, _, _, _, let pillColor) = decoded {
            XCTAssertEqual(tabId, "t9")
            XCTAssertEqual(pillColor, "#4ece78")
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

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: nil, lastActivityAt: 1234, lastMessage: "preview", messageCount: 9)

        let tab = vm.tabs[0]
        XCTAssertEqual(tab.lastActivityAt, 1234)
        XCTAssertEqual(tab.lastMessage, "preview")
        XCTAssertEqual(tab.messageCount, 9)
    }

    /// Legacy behavior preserved: a cost-only delta still applies cost and
    /// leaves the volatile fields untouched.
    func testHandleTabMetaLegacyCostOnlyStillWorks() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "t1")
        tab.lastMessage = "keep-me"
        vm.tabs = [tab]

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: 0.5)

        XCTAssertEqual(vm.tabs[0].runCostUsd, 0.5)
        XCTAssertEqual(vm.tabs[0].totalCostUsd, 0.5)
        XCTAssertEqual(vm.tabs[0].lastMessage, "keep-me", "absent volatile fields must not clobber existing state")
    }

    /// handleTabMeta must merge a fresh pillColor into tab state.
    func testHandleTabMetaMergesPillColorIntoTabState() {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "t1")]

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: nil, pillColor: "#ef5350")

        let tab = vm.tabs[0]
        XCTAssertEqual(tab.pillColor, "#ef5350")
    }

    /// A delta that omits pillColor (nil) must not clobber an existing
    /// pillColor set by a prior delta — same "absent means no
    /// change" contract as title above.
    func testHandleTabMetaOmittedPillColorDoNotClobberExisting() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "t1")
        tab.pillColor = "#f08c4a"
        vm.tabs = [tab]

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: 0.5)

        XCTAssertEqual(vm.tabs[0].pillColor, "#f08c4a", "absent pillColor must not clobber existing state")
    }

    /// Explicit JSON null must clear customization rather than being treated as
    /// an omitted delta field.
    func testHandleTabMetaExplicitNullPillColorClearExisting() {
        let vm = SessionViewModel()
        var tab = makeTab(id: "t1")
        tab.pillColor = "#f08c4a"
        vm.tabs = [tab]

        vm.handleTabMeta(tabId: "t1", title: nil, totalCostUsd: nil, pillColor: .some(nil))

        XCTAssertNil(vm.tabs[0].pillColor)
    }
}
