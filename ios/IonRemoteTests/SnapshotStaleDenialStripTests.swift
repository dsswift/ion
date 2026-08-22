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
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _, _, _) = event else {
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
}
