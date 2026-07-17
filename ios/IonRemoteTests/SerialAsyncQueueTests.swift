import XCTest
@testable import IonRemote

/// Pins the strict-FIFO / no-overlap contract of SerialAsyncQueue — the
/// mechanism that makes outbound seq allocation + socket write atomic so wire
/// order always equals seq order (TransportManager+Send.swift).
final class SerialAsyncQueueTests: XCTestCase {

    /// Operations complete in registration order even when later operations
    /// are much faster than earlier ones. Pre-fix, concurrent `Task {}` sends
    /// had no such guarantee: a fast later send could hit the wire first.
    /// Registration via `submit` is synchronous, so the loop order below IS
    /// the FIFO order the queue must honor.
    func testCompletionOrderIsRegistrationOrder() async throws {
        let queue = SerialAsyncQueue()
        let order = OSAllocatedUnfairLockBox<[Int]>([])

        // Earlier ops sleep longer than later ops; FIFO must still hold.
        var handles: [Task<Void, Error>] = []
        for i in 0..<8 {
            let sleepMs = (8 - i) * 5
            handles.append(queue.submit {
                try? await Task.sleep(for: .milliseconds(sleepMs))
                order.mutate { $0.append(i) }
            })
        }
        for handle in handles { try await handle.value }

        XCTAssertEqual(order.value, Array(0..<8),
            "Operations must complete in registration order regardless of per-op duration")
    }

    /// No two operations ever run concurrently.
    func testOperationsNeverOverlap() async throws {
        let queue = SerialAsyncQueue()
        let active = OSAllocatedUnfairLockBox<(current: Int, maxSeen: Int)>((0, 0))

        var handles: [Task<Void, Error>] = []
        for _ in 0..<10 {
            handles.append(Task {
                try await queue.enqueue {
                    active.mutate {
                        $0.current += 1
                        $0.maxSeen = max($0.maxSeen, $0.current)
                    }
                    try? await Task.sleep(for: .milliseconds(2))
                    active.mutate { $0.current -= 1 }
                }
            })
        }
        for handle in handles { try await handle.value }

        XCTAssertEqual(active.value.maxSeen, 1,
            "At most one operation may be in flight at any moment")
    }

    /// An operation's error propagates to its caller but does not poison the
    /// chain — the next operation still runs.
    func testErrorPropagatesWithoutBreakingChain() async throws {
        struct Boom: Error {}
        let queue = SerialAsyncQueue()

        let failing = Task {
            try await queue.enqueue { throw Boom() }
        }
        do {
            try await failing.value
            XCTFail("Expected Boom to propagate")
        } catch is Boom {
            // expected
        }

        let result = try await queue.enqueue { "still-alive" }
        XCTAssertEqual(result, "still-alive",
            "A failed operation must not block subsequent operations")
    }

    /// Results round-trip through the queue.
    func testReturnsOperationResult() async throws {
        let queue = SerialAsyncQueue()
        let value = try await queue.enqueue { 41 + 1 }
        XCTAssertEqual(value, 42)
    }
}

/// Minimal thread-safe box for test bookkeeping.
final class OSAllocatedUnfairLockBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T
    init(_ initial: T) { stored = initial }
    var value: T {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
    func mutate(_ body: (inout T) -> Void) {
        lock.lock(); defer { lock.unlock() }
        body(&stored)
    }
}
