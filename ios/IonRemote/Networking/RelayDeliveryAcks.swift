import Foundation

/// Correlates an iOS outbound wire sequence with the relay's blind forwarding
/// outcome. The relay can read only envelope seq, not ciphertext. A successful
/// WebSocket write therefore remains provisional until `relay:forwarded`.
final class RelayDeliveryAcks: @unchecked Sendable {
    enum Outcome: Sendable {
        case forwarded
        case unavailable(reason: String)
    }

    private let lock = NSLock()
    private var pendingSequences: Set<UInt64> = []
    private var waiters: [UInt64: CheckedContinuation<Outcome, Never>] = [:]
    /// An ACK can arrive between the relay write and waiter registration. Keep
    /// that outcome only while its sequence is an active strict send.
    private var resolvedOutcomes: [UInt64: Outcome] = [:]

    /// Marks a sequence as eligible for an ACK before its relay write starts.
    /// ACKs for unknown or cancelled sequences are stale transport traffic and
    /// must not create retained state.
    func begin(sequence: UInt64) {
        lock.lock()
        pendingSequences.insert(sequence)
        lock.unlock()
    }

    func wait(for sequence: UInt64) async -> Outcome {
        await withCheckedContinuation { continuation in
            lock.lock()
            guard pendingSequences.contains(sequence) else {
                lock.unlock()
                continuation.resume(returning: .unavailable(reason: "delivery_cancelled"))
                return
            }
            if let outcome = resolvedOutcomes.removeValue(forKey: sequence) {
                pendingSequences.remove(sequence)
                lock.unlock()
                continuation.resume(returning: outcome)
                return
            }
            waiters[sequence] = continuation
            lock.unlock()
        }
    }

    func resolve(sequence: UInt64, outcome: Outcome) {
        lock.lock()
        guard pendingSequences.contains(sequence) else {
            lock.unlock()
            return
        }
        let waiter = waiters.removeValue(forKey: sequence)
        if waiter == nil {
            resolvedOutcomes[sequence] = outcome
        } else {
            pendingSequences.remove(sequence)
        }
        lock.unlock()
        waiter?.resume(returning: outcome)
    }

    /// Cancels one strict-delivery wait. This resumes any registered waiter so
    /// the task cannot remain suspended after its send deadline has elapsed.
    func cancel(sequence: UInt64, reason: String) {
        lock.lock()
        pendingSequences.remove(sequence)
        resolvedOutcomes.removeValue(forKey: sequence)
        let waiter = waiters.removeValue(forKey: sequence)
        lock.unlock()
        waiter?.resume(returning: .unavailable(reason: reason))
    }

    func cancelAll(reason: String) {
        lock.lock()
        let pending = waiters.values
        pendingSequences.removeAll()
        waiters.removeAll()
        resolvedOutcomes.removeAll()
        lock.unlock()
        for waiter in pending {
            waiter.resume(returning: .unavailable(reason: reason))
        }
    }
}
