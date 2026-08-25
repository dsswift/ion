import Foundation

// MARK: - Send deadline

/// Error thrown by `withSendDeadline` when the operation does not complete
/// within the deadline. Callers treat this as a transport failure: a WebSocket
/// send that cannot complete in seconds means the TCP connection is wedged
/// (half-open socket, dead peer) even though the task still reports `.running`.
enum SendDeadlineError: Error, LocalizedError {
    case timedOut(seconds: Double)

    var errorDescription: String? {
        switch self {
        case .timedOut(let seconds):
            return "Send timed out after \(seconds)s (transport wedged)"
        }
    }
}

/// Transport deadlines shared by the WebSocket clients. A healthy send
/// completes in milliseconds. A healthy relay connect produces its first frame
/// within a few seconds. These bounds prevent a wedged socket from blocking all
/// later work while still allowing normal mobile network changes to settle.
let transportSendDeadlineSeconds: Double = 5.0
let transportConnectDeadlineSeconds: Double = 10.0

/// Race `operation` against a wall-clock deadline.
///
/// Returns the operation's result if it completes first; throws
/// `SendDeadlineError.timedOut` if the deadline elapses first. The losing
/// branch is cancelled (the sleep cancels cleanly; an abandoned socket send is
/// torn down by the caller's disconnect handling).
func withSendDeadline<T: Sendable>(
    seconds: Double,
    operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            throw SendDeadlineError.timedOut(seconds: seconds)
        }
        do {
            // First child to finish wins; a nil next() cannot happen with two
            // children but is mapped to the timeout error defensively.
            guard let result = try await group.next() else {
                throw SendDeadlineError.timedOut(seconds: seconds)
            }
            group.cancelAll()
            return result
        } catch {
            group.cancelAll()
            throw error
        }
    }
}
