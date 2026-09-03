import XCTest
@testable import IonRemote

/// Regression: stale permissionDenied promotion stripped from snapshot queue
/// on running/connecting tabs.
///
/// ROOT CAUSE: the desktop's snapshot.ts previously promoted the active
/// instance's permissionDenied into the iOS permissionQueue for any tab
/// where status != failed/dead. permissionDenied is cleared lazily, so a
/// running tab kept the resolved denial and the snapshot re-promoted it to
/// iOS on every poll. iOS showed the stale ExitPlanMode/AskUserQuestion card
/// while the desktop had already hidden it.
///
/// FIX 1 (desktop): extend the IIFE promotion guard to exclude running and
/// connecting tabs (snapshot.ts). FIX 2 (iOS — belt-and-suspenders): in
/// SessionViewModel+Snapshot.swift's handleSnapshot, strip snapshot entries
/// whose questionId starts with "denied-" when the tab is running or connecting.
///
/// These tests exercise the iOS strip. The discriminator: reverting the
/// `isRunningOrConnecting && entry.questionId.hasPrefix("denied-")` guard
/// from removeAll means neither the running nor the connecting case strips the
/// entry → the assertions below fail.
@MainActor
final class SnapshotStaleDenialStripTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Helpers

    /// Build a minimal snapshot JSON with one tab carrying the given queue entry.
    private func snapshotJSON(status: String, questionId: String, toolName: String) -> Data {
        let json = """
        {"type":"desktop_snapshot","tabs":[{
          "id":"tab-1",
          "title":"Test Tab",
          "customTitle":null,
          "status":"\(status)",
          "workingDirectory":"/tmp",
          "permissionMode":"auto",
          "permissionQueue":[{
            "questionId":"\(questionId)",
            "toolName":"\(toolName)",
            "toolInput":{},
            "options":[]
          }],
          "lastMessage":null,
          "contextTokens":null
        }]}
        """
        return json.data(using: .utf8)!
    }

    private func applySnapshot(status: String, questionId: String, toolName: String) throws -> [PermissionRequest] {
        let vm = SessionViewModel()
        let data = snapshotJSON(status: status, questionId: questionId, toolName: toolName)
        let event = try decoder.decode(RemoteEvent.self, from: data)
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _, _, _, _) = event else {
            XCTFail("Expected snapshot"); return []
        }
        XCTAssertEqual(tabs[0].permissionQueue.count, 1, "pre-condition: raw snapshot has the entry")
        vm.handleSnapshot(snapshotTabs: tabs, recentDirs: [], groupMode: nil, groups: nil)
        return vm.tabs.first(where: { $0.id == "tab-1" })?.permissionQueue ?? []
    }

    // MARK: - Running tab strips denied-* entries

    func testRunningTabStripesDeniedExitPlanMode() throws {
        let after = try applySnapshot(status: "running", questionId: "denied-toolu_abc123", toolName: "ExitPlanMode")
        XCTAssertEqual(after.count, 0,
            "running tab: denied-* ExitPlanMode entry must be stripped from the snapshot queue (Fix 2 belt-and-suspenders)")
    }

    func testRunningTabStripesDeniedAskUserQuestion() throws {
        let after = try applySnapshot(status: "running", questionId: "denied-toolu_xyz987", toolName: "AskUserQuestion")
        XCTAssertEqual(after.count, 0,
            "running tab: denied-* AskUserQuestion entry must be stripped (Fix 2)")
    }

    func testConnectingTabStripesDeniedEntry() throws {
        let after = try applySnapshot(status: "connecting", questionId: "denied-toolu_conn1", toolName: "ExitPlanMode")
        XCTAssertEqual(after.count, 0,
            "connecting tab: denied-* entry must be stripped (same guard as running)")
    }

    // MARK: - Idle / completed tabs retain denied-* entries

    func testIdleTabRetainsDeniedEntry() throws {
        // An idle tab may carry a genuine outstanding denial from a background
        // sub-agent dispatch. The strip must NOT fire for idle tabs.
        let after = try applySnapshot(status: "idle", questionId: "denied-toolu_idle1", toolName: "ExitPlanMode")
        XCTAssertEqual(after.count, 1,
            "idle tab: denied-* entry must be RETAINED — background sub-agent path must reach iOS")
        XCTAssertEqual(after.first?.questionId, "denied-toolu_idle1")
    }

    func testCompletedTabRetainsDeniedEntry() throws {
        let after = try applySnapshot(status: "completed", questionId: "denied-toolu_done1", toolName: "AskUserQuestion")
        XCTAssertEqual(after.count, 1,
            "completed tab: denied-* entry must be RETAINED")
        XCTAssertEqual(after.first?.questionId, "denied-toolu_done1")
    }

    // MARK: - Non-denied entries on running tabs are not touched

    func testRunningTabRetainsNonDeniedEntry() throws {
        // A genuine live permission request on a running tab must survive.
        // Its questionId does NOT carry the "denied-" prefix.
        let after = try applySnapshot(status: "running", questionId: "live-qid-abc", toolName: "ExitPlanMode")
        XCTAssertEqual(after.count, 1,
            "running tab: a live (non-denied-*) ExitPlanMode entry must NOT be stripped")
        XCTAssertEqual(after.first?.questionId, "live-qid-abc")
    }

    // MARK: - Confirmed-then-omitted card is dropped (the reported bug)

    /// The reported bug: a completed conversation whose plan was implemented kept
    /// showing the Plan Ready card ("Input" in the tab list) on iOS. The desktop
    /// had cleared its permissionDenied, so its snapshots no longer carried the
    /// card — but the snapshot merge re-injected iOS's local copy on every poll,
    /// because the "don't re-inject" guard fired only on `.running`, never on a
    /// terminal (idle/completed) tab. The card lived in memory for days.
    ///
    /// FIX: once a snapshot has carried a promoted (`denied-*`) special card, the
    /// desktop's queue is authoritative for it — a later snapshot that omits it
    /// drops the stale local copy instead of re-injecting it.
    ///
    /// Discriminator: reverting the `snapshotConfirmedSpecialIds` drop in
    /// SessionViewModel+Snapshot.swift makes this test go red — the second
    /// snapshot re-injects the local entry and the queue is non-empty.

    /// Build a snapshot with one idle tab carrying an arbitrary set of entries.
    private func idleSnapshotJSON(entries: [(String, String)]) -> Data {
        let queue = entries.map { qid, tool in
            "{\"questionId\":\"\(qid)\",\"toolName\":\"\(tool)\",\"toolInput\":{},\"options\":[]}"
        }.joined(separator: ",")
        let json = """
        {"type":"desktop_snapshot","tabs":[{
          "id":"tab-1","title":"T","customTitle":null,"status":"completed",
          "workingDirectory":"/tmp","permissionMode":"auto",
          "permissionQueue":[\(queue)],"lastMessage":null,"contextTokens":null
        }]}
        """
        return json.data(using: .utf8)!
    }

    private func applySnapshotData(_ vm: SessionViewModel, _ data: Data) throws {
        let event = try decoder.decode(RemoteEvent.self, from: data)
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _, _, _, _) = event else {
            XCTFail("Expected snapshot"); return
        }
        vm.handleSnapshot(snapshotTabs: tabs, recentDirs: [], groupMode: nil, groups: nil)
    }

    func testConfirmedThenOmittedCardIsDropped() throws {
        let vm = SessionViewModel()
        // Snapshot 1: completed tab carries the promoted plan card. iOS shows it
        // AND records it as snapshot-confirmed.
        try applySnapshotData(vm, idleSnapshotJSON(entries: [("denied-toolu_impl1", "ExitPlanMode")]))
        XCTAssertEqual(vm.tabs.first(where: { $0.id == "tab-1" })?.permissionQueue.count, 1,
            "pre-condition: first snapshot surfaces the card")
        // Snapshot 2: the desktop resolved the plan (implemented) — same completed
        // tab, empty queue. The confirmed-then-omitted card must be dropped, not
        // re-injected.
        try applySnapshotData(vm, idleSnapshotJSON(entries: []))
        XCTAssertEqual(vm.tabs.first(where: { $0.id == "tab-1" })?.permissionQueue.count, 0,
            "confirmed card omitted by a later snapshot must be dropped (the reported bug)")
    }

    func testUnconfirmedLiveCardSurvivesSnapshotRace() throws {
        // Flicker guard: a card that arrived via a LIVE permission_request (not yet
        // carried by any snapshot) must survive a snapshot that omits it — it is
        // still racing the desktop's next promotion, so the omission is not
        // authoritative. This is the background sub-agent / task_complete forward.
        let vm = SessionViewModel()
        // Establish the completed tab with an empty queue (confirms nothing).
        try applySnapshotData(vm, idleSnapshotJSON(entries: []))
        // Live-forward a plan card onto the (completed) tab.
        vm.handlePermissionRequest(tabId: "tab-1", questionId: "denied-toolu_fresh1",
                                   toolName: "ExitPlanMode", toolInput: nil, options: [])
        XCTAssertEqual(vm.tabs.first(where: { $0.id == "tab-1" })?.permissionQueue.count, 1,
            "pre-condition: live card is queued")
        // A snapshot that omits the still-unconfirmed card must NOT drop it.
        try applySnapshotData(vm, idleSnapshotJSON(entries: []))
        XCTAssertEqual(vm.tabs.first(where: { $0.id == "tab-1" })?.permissionQueue.count, 1,
            "unconfirmed live card must survive the snapshot race (no flicker)")
    }
}
