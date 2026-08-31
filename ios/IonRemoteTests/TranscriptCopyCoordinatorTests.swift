import XCTest
@testable import IonRemote

@MainActor
final class TranscriptCopyCoordinatorTests: XCTestCase {
    func testMatchingResponseResolvesAndClearsPendingRequest() {
        let coordinator = TranscriptCopyCoordinator(makeRequestId: { "request-1" })
        let requestId = coordinator.begin(tabId: "tab-1") { _, _ in
            XCTFail("Timeout must not fire")
        }

        XCTAssertEqual(requestId, "request-1")
        XCTAssertEqual(coordinator.resolve(
            tabId: "tab-1",
            requestId: "request-1",
            transcript: "text",
            error: nil
        ), .copied("text"))
        XCTAssertNil(coordinator.pendingRequestId)
    }

    func testStaleResponseIsIgnored() {
        let coordinator = TranscriptCopyCoordinator(makeRequestId: { "latest" })
        _ = coordinator.begin(tabId: "tab-1") { _, _ in }

        XCTAssertNil(coordinator.resolve(
            tabId: "tab-1",
            requestId: "old",
            transcript: "stale",
            error: nil
        ))
        XCTAssertEqual(coordinator.pendingRequestId, "latest")
    }

    func testEmptyAndErrorResponsesAreDistinct() {
        let ids = ["empty", "error"]
        var index = 0
        let coordinator = TranscriptCopyCoordinator(makeRequestId: {
            defer { index += 1 }
            return ids[index]
        })

        _ = coordinator.begin(tabId: "tab-1") { _, _ in }
        XCTAssertEqual(coordinator.resolve(tabId: "tab-1", requestId: "empty", transcript: "", error: nil), .empty)

        _ = coordinator.begin(tabId: "tab-1") { _, _ in }
        XCTAssertEqual(coordinator.resolve(tabId: "tab-1", requestId: "error", transcript: "", error: "failed"), .failed("failed"))
    }

    func testTimeoutClearsPendingRequest() async {
        let coordinator = TranscriptCopyCoordinator(timeout: .milliseconds(10), makeRequestId: { "timeout" })
        let expectation = expectation(description: "timeout")
        _ = coordinator.begin(tabId: "tab-1") { tabId, requestId in
            XCTAssertEqual(tabId, "tab-1")
            XCTAssertEqual(requestId, "timeout")
            expectation.fulfill()
        }

        await fulfillment(of: [expectation], timeout: 1)
        XCTAssertNil(coordinator.pendingRequestId)
    }
}
