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

/// The default outbound send deadline shared by the relay and LAN clients.
/// A healthy WebSocket send completes in milliseconds; 5 seconds is far past
/// any legitimate slow path and well before commands pile up behind a wedged
/// socket and later fail en masse with "Operation canceled".
let transportSendDeadlineSeconds: Double = 5.0

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
