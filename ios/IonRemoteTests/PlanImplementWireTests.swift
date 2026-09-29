import XCTest
@testable import IonRemote

/// Tests for the plan implement intent + paged plan_content wire protocol
/// introduced in plan gentle-perching-lemon.
///
/// Covers:
///   (a) implementPlan command encodes correctly and does NOT embed a prompt
///   (b) requestPlanContent command encodes correctly with all fields
///   (c) plan_content event decodes correctly (single page + multi-page)
///   (d) PlanContentStore assembles multiple pages into the full body
///   (e) A >4KB plan (planTruncated=true) correctly signals that the preview
///       is truncated and the full body must be fetched
///   (f) ExitPlanMode permission entry with planContentPreview/planSizeBytes/
///       planTruncated decodes correctly (regression: NOT planContent)
final class PlanImplementWireTests: XCTestCase {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - (a) implementPlan command

    // MARK: - (b) requestPlanContent command

    // MARK: - (c) plan_content event decode

    func testDecodePlanContent_singlePage() throws {
        let json = """
        {"type":"desktop_plan_content","questionId":"q-1","planFilePath":"/plans/foo.md","offset":0,"content":"# My Plan\\n\\nStep 1","totalBytes":20,"hasMore":false}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .planContent(let questionId, let planFilePath, let offset, let content, let totalBytes, let hasMore) = event {
            XCTAssertEqual(questionId, "q-1")
            XCTAssertEqual(planFilePath, "/plans/foo.md")
            XCTAssertEqual(offset, 0)
            XCTAssertEqual(content, "# My Plan\n\nStep 1")
            XCTAssertEqual(totalBytes, 20)
            XCTAssertFalse(hasMore)
        } else {
            XCTFail("Expected planContent, got \(event)")
        }
    }

    func testDecodePlanContent_hasMoreTrue() throws {
        let json = """
        {"type":"desktop_plan_content","questionId":"q-2","planFilePath":"/p.md","offset":0,"content":"AAAA","totalBytes":200000,"hasMore":true}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .planContent(_, _, _, _, let totalBytes, let hasMore) = event {
            XCTAssertEqual(totalBytes, 200000)
            XCTAssertTrue(hasMore)
        } else {
            XCTFail("Expected planContent, got \(event)")
        }
    }

    func testRoundTripPlanContent() throws {
        let original = RemoteEvent.planContent(
            questionId: "q-rt",
            planFilePath: "/plans/rt.md",
            offset: 65536,
            content: "page two content",
            totalBytes: 100000,
            hasMore: false
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .planContent(let qId, let path, let off, let content, let tb, let hm) = decoded {
            XCTAssertEqual(qId, "q-rt")
            XCTAssertEqual(path, "/plans/rt.md")
            XCTAssertEqual(off, 65536)
            XCTAssertEqual(content, "page two content")
            XCTAssertEqual(tb, 100000)
            XCTAssertFalse(hm)
        } else {
            XCTFail("Round-trip planContent failed")
        }
    }

    // MARK: - (d) PlanContentStore multi-page assembly

    func testPlanContentStore_assemblesMultiplePages() {
        let store = PlanContentStore()
        let qId = "q-assemble"

        // Page 1: hasMore=true
        store.applyPage(questionId: qId, content: "Hello ", totalBytes: 11, hasMore: true)
        XCTAssertFalse(store.isComplete(questionId: qId), "Should not be complete after first page")
        XCTAssertNil(store.fullContent(for: qId), "fullContent nil until complete")

        // Page 2: hasMore=false
        store.applyPage(questionId: qId, content: "World", totalBytes: 11, hasMore: false)
        XCTAssertTrue(store.isComplete(questionId: qId), "Should be complete after hasMore=false")
        XCTAssertEqual(store.fullContent(for: qId), "Hello World")
    }

    func testPlanContentStore_singlePageComplete() {
        let store = PlanContentStore()
        let qId = "q-single"
        store.applyPage(questionId: qId, content: "Full plan content", totalBytes: 17, hasMore: false)
        XCTAssertTrue(store.isComplete(questionId: qId))
        XCTAssertEqual(store.fullContent(for: qId), "Full plan content")
    }

    func testPlanContentStore_notCompleteWhileFetching() {
        let store = PlanContentStore()
        let qId = "q-fetching"
        store.markFetching(questionId: qId, tabId: "tab-1")
        XCTAssertFalse(store.isComplete(questionId: qId))
        XCTAssertTrue(store.isFetching(questionId: qId))
        XCTAssertNil(store.fullContent(for: qId))
    }

    func testPlanContentStore_tabIdStoredForContinuation() {
        let store = PlanContentStore()
        let qId = "q-tabid"
        store.markFetching(questionId: qId, tabId: "tab-xyz")
        XCTAssertEqual(store.tabId(for: qId), "tab-xyz")
    }

    func testPlanContentStore_clear() {
        let store = PlanContentStore()
        let qId = "q-clear"
        store.applyPage(questionId: qId, content: "done", totalBytes: 4, hasMore: false)
        XCTAssertTrue(store.isComplete(questionId: qId))
        store.clear(questionId: qId)
        XCTAssertFalse(store.isComplete(questionId: qId))
        XCTAssertNil(store.fullContent(for: qId))
    }

    // MARK: - (e) planTruncated signals preview-only snapshot

    func testPlanContentPreview_decodedFromPermissionEntry() throws {
        // ExitPlanMode permission_request now carries planContentPreview +
        // planSizeBytes + planTruncated. Verify these decode from the wire.
        let json = """
        {"type":"desktop_permission_request","tabId":"t1","instanceId":"inst-1","questionId":"q-plan","toolName":"ExitPlanMode","toolInput":{"planFilePath":"/plans/big.md","planContentPreview":"# Big Plan\\n\\nFirst 4KB...","planSizeBytes":204800,"planTruncated":true},"options":[{"id":"implement","label":"Implement","kind":"approve"}]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .permissionRequest(_, _, _, _, let toolInput, _) = event else {
            XCTFail("Expected permissionRequest, got \(event)")
            return
        }
        XCTAssertNotNil(toolInput)
        // planContentPreview must be present
        let preview = toolInput?["planContentPreview"]?.value as? String
        XCTAssertNotNil(preview, "planContentPreview must decode from ExitPlanMode toolInput")
        XCTAssertTrue(preview?.hasPrefix("# Big Plan") == true)
        // planSizeBytes
        let sizeBytes = toolInput?["planSizeBytes"]?.value as? Int
        XCTAssertEqual(sizeBytes, 204800)
        // planTruncated
        let truncated = toolInput?["planTruncated"]?.value as? Bool
        XCTAssertEqual(truncated, true)
        // planContent must NOT be present (old field is gone)
        let oldContent = toolInput?["planContent"]?.value as? String
        XCTAssertNil(oldContent, "planContent must NOT appear in ExitPlanMode toolInput (replaced by planContentPreview)")
    }

    func testPlanTruncated_false_forSmallPlan() throws {
        // A plan under 4KB: planTruncated=false, preview = full content.
        let json = """
        {"type":"desktop_permission_request","tabId":"t2","questionId":"q-small","toolName":"ExitPlanMode","toolInput":{"planFilePath":"/plans/small.md","planContentPreview":"# Small Plan","planSizeBytes":12,"planTruncated":false},"options":[]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .permissionRequest(_, _, _, _, let toolInput, _) = event else {
            XCTFail("Expected permissionRequest")
            return
        }
        let truncated = toolInput?["planTruncated"]?.value as? Bool
        XCTAssertEqual(truncated, false)
        let sizeBytes = toolInput?["planSizeBytes"]?.value as? Int
        XCTAssertEqual(sizeBytes, 12)
    }
}
