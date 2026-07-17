import XCTest
@testable import IonRemote

/// Pins the outbound send-deadline mechanism (SendDeadline.swift) that bounds
/// every relay/LAN socket write. A wedged TCP connection keeps the WebSocket
/// task `.running` while `send` never completes; pre-fix, commands awaited
/// indefinitely and later failed en masse with "Operation canceled".
final class SendDeadlineTests: XCTestCase {

    /// An operation that never completes must throw SendDeadlineError once the
    /// deadline elapses — this is the wedged-socket case.
    func testNeverCompletingOperationTimesOut() async {
        do {
            try await withSendDeadline(seconds: 0.05) {
                // Simulates a socket send that never returns.
                try await Task.sleep(for: .seconds(30))
            }
            XCTFail("Expected SendDeadlineError.timedOut")
        } catch is SendDeadlineError {
            // expected
        } catch {
            XCTFail("Expected SendDeadlineError, got \(error)")
        }
    }

    /// A fast operation returns its result and does not time out.
    func testFastOperationReturnsResult() async throws {
        let result = try await withSendDeadline(seconds: 5.0) { "sent" }
        XCTAssertEqual(result, "sent")
    }

    /// The operation's own error propagates unchanged (it is not masked as a
    /// timeout).
    func testOperationErrorPropagates() async {
        struct SocketDown: Error {}
        do {
            try await withSendDeadline(seconds: 5.0) { throw SocketDown() }
            XCTFail("Expected SocketDown")
        } catch is SocketDown {
            // expected
        } catch {
            XCTFail("Expected SocketDown, got \(error)")
        }
    }

    /// The timeout errors surfaced by the transport clients are distinct,
    /// descriptive error cases (they drive teardown + user-visible requeue).
    func testClientTimeoutErrorDescriptions() {
        XCTAssertTrue(RelayClientError.sendTimeout.errorDescription?.contains("timed out") ?? false)
        XCTAssertTrue(LANClientError.sendTimeout.errorDescription?.contains("timed out") ?? false)
    }
}
