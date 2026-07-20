import Foundation
import os

// MARK: - SerialAsyncQueue

/// A strict-FIFO async work queue: each enqueued operation runs to completion
/// before the next one starts, even when the operations themselves suspend.
///
/// Why this exists: a plain Swift `actor` does NOT provide this guarantee —
/// actor reentrancy allows a second method call to interleave at every `await`
/// suspension point. The transport layer needs "allocate outbound seq, then
/// write to the socket" to be one atomic unit so the wire order always matches
/// the seq order. Concurrent `Task {}` sends used to allocate seqs under a lock
/// but race the socket writes that followed, letting a later seq hit the wire
/// first (the desktop's dedup then punished the reorder).
///
/// Implementation: a lock-guarded task chain. Each enqueue creates a task that
/// first awaits the previous tail, then runs its operation. Errors propagate to
/// the caller of `enqueue` but never break the chain (the chained tail swallows
/// the error so the next operation still runs).
final class SerialAsyncQueue: @unchecked Sendable {

    /// Tail of the chain: completes when the most recently enqueued operation
    /// has finished (successfully or not). Guarded by `lock`.
    private let lock = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)

    /// Register `operation` behind every previously registered operation and
    /// return its handle. Registration is SYNCHRONOUS (lock-ordered), so the
    /// FIFO position is fixed at the moment `submit` returns — callers that
    /// need a deterministic order call `submit` in that order.
    func submit<T>(_ operation: @escaping () async throws -> T) -> Task<T, Error> {
        lock.withLock { tail in
            let previous = tail
            let next = Task<T, Error> {
                // Wait for the previous operation to fully complete before
                // starting this one — this is the FIFO/no-overlap guarantee.
                if let previous { await previous.value }
                return try await operation()
            }
            // The chain tail ignores the result/error so one failed send does
            // not poison every send queued behind it — but log the drop so a
            // failed send in the chain is countable rather than fully silent.
            tail = Task {
                do {
                    _ = try await next.value
                } catch {
                    DiagnosticLog.log("serial queue operation failed (chain continues)", tag: "transport.queue", level: .warn, fields: [
                        "error": String(describing: error),
                    ])
                }
            }
            return next
        }
    }

    /// Run `operation` after every previously enqueued operation has completed.
    /// Returns the operation's result (or rethrows its error) to the caller.
    func enqueue<T>(_ operation: @escaping () async throws -> T) async throws -> T {
        try await submit(operation).value
    }
}
