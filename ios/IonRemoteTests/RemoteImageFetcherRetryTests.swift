import XCTest
@testable import IonRemote

/// RC-20: RemoteImageFetcher must recover from a transient fetch failure. A nil
/// deliver (desktop dropped the response on a transport switch) must NOT
/// permanently blacklist the path, and a reconnect/unpair must clear the
/// transient failed/pending sets so a retry can succeed.
@MainActor
final class RemoteImageFetcherRetryTests: XCTestCase {

    func testNilDeliverDoesNotPermanentlyBlacklist() {
        let fetcher = RemoteImageFetcher.shared
        fetcher.resetTransientState()
        let vm = SessionViewModel()
        let path = "/tmp/img-\(UUID().uuidString).png"

        // First request → in flight. deliver nil (transient failure).
        var firstResult: UIImage?? = nil
        fetcher.request(path: path, viewModel: vm) { firstResult = $0 }
        fetcher.deliver(path: path, dataUrl: nil)
        XCTAssertNil(firstResult ?? nil, "transient failure resolves the current observer with nil")

        // A subsequent request must NOT short-circuit to nil (path not blacklisted):
        // it enters the pending state and re-issues the fetch. We detect "not
        // blacklisted" by observing the completion is NOT called synchronously.
        var retryCalledSynchronously = false
        var retryResolved = false
        fetcher.request(path: path, viewModel: vm) { _ in retryResolved = true }
        retryCalledSynchronously = retryResolved
        XCTAssertFalse(retryCalledSynchronously,
            "after a transient nil deliver, a retry must re-fetch (pending), not short-circuit to nil")

        // A successful deliver now resolves the retry with an image (1x1 PNG).
        let onePx = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
        fetcher.deliver(path: path, dataUrl: onePx)
        XCTAssertTrue(retryResolved, "a successful deliver after a transient failure resolves the retry")
    }

    func testResetTransientStateClearsFailed() {
        let fetcher = RemoteImageFetcher.shared
        fetcher.resetTransientState()
        let vm = SessionViewModel()
        let path = "/tmp/img-\(UUID().uuidString).png"

        // Drive a request + nil deliver, then reset.
        fetcher.request(path: path, viewModel: vm) { _ in }
        fetcher.deliver(path: path, dataUrl: nil)
        fetcher.resetTransientState()

        // After reset, a fresh request enters pending (re-fetch), never a
        // synchronous nil short-circuit.
        var resolvedSync = false
        var resolved = false
        fetcher.request(path: path, viewModel: vm) { _ in resolved = true }
        resolvedSync = resolved
        XCTAssertFalse(resolvedSync, "resetTransientState must clear failed so a fresh request re-fetches")
    }
}
