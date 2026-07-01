import Foundation

// MARK: - Run-when-connected helper
//
// This file owns the small "defer this block until the transport is actually
// usable" helper. It's split out of SessionViewModel.swift because that file
// is allowlisted (don't extend; extract) -- but the stored queue (`pendingOnConnected`)
// has to live on the type itself since Swift forbids stored properties in
// extensions. So the property is declared in SessionViewModel.swift next to
// `connectionState`, and the read/write methods live here.
//
// ## Why this exists
//
// On iOS scene resume the `.active` scenePhase handler kicks off a soft
// transport reconnect, then immediately fires fire-and-forget commands
// (`requestAllGitChanges`, `sendReportFocus`) to refresh state on the
// desktop. Those sends race the LAN/relay handshake:
//
//   - If they land while `tearDownTransport()` has briefly cleared
//     `self.transport`, the `guard let transport else` branch in
//     `SessionViewModel+Commands.swift` toasts "Not connected".
//   - If they land while the transport reference is non-nil but neither
//     `lan.isConnected` nor `relay.isConnected` is true yet,
//     `TransportManager+Send.swift` throws `.noTransportAvailable` and
//     the catch in `send(...)` toasts "Send failed".
//
// Either way the user sees a spurious error toast on every foreground
// before they've done anything. The right fix is to wait for the only
// signal that proves the transport is actually usable -- the first
// snapshot arriving, which flips `connectionState` to `.connected` in
// `handleSnapshot`. This helper lets callers express that intent in a
// single line.
//
// ## Scope
//
// Only the auto-fired resume commands route through `runWhenConnected`.
// Manual user actions (taps, prompts) keep going through `send(...)`
// directly -- a user-initiated send that races a disconnect *should*
// toast (that's legitimate feedback). The fix targets only the
// lifecycle-driven sends the user didn't initiate.
//
// ## Essential deferred queue
//
// A second, keyed queue (`pendingEssentialQueue` on SessionViewModel) handles
// `.automaticEssential` sends that arrive while not-connected. It deduplicates
// by command-identity key (last-write-wins) so that rapid re-triggers of the
// same automatic send (e.g. multiple `.onAppear`/`.task` fires during reconnect)
// produce exactly one wire send once the transport is proven usable. Both queues
// drain at the same `handleSnapshot` seam; both are cleared on hard disconnect.

extension SessionViewModel {

    // MARK: - Run-when-connected (closure queue)

    /// Run `block` once the transport reaches `.connected`. If already
    /// connected, runs synchronously on the current actor; otherwise
    /// appends to `pendingOnConnected` and waits for `handleSnapshot` to
    /// drain the queue on the next `.connected` transition.
    ///
    /// Caller contract: `block` must be safe to invoke from the actor
    /// context the drain happens on -- `handleSnapshot` is `@MainActor`,
    /// so in practice blocks always run on the main actor. This method
    /// itself is not actor-isolated so it can be called from
    /// `disconnect()` and other non-isolated lifecycle hooks without
    /// suspending; the call sites today all happen to be on the main
    /// actor anyway.
    ///
    /// This is the precise mechanism for "fire this when the transport
    /// can actually deliver it" -- never a timer, never a sleep. See the
    /// file header for the failure mode this prevents.
    func runWhenConnected(_ block: @escaping () -> Void) {
        if connectionState == .connected {
            DiagnosticLog.log("RUN-WHEN-CONNECTED: immediate (state=connected)")
            block()
            return
        }
        DiagnosticLog.log("RUN-WHEN-CONNECTED: enqueued (state=\(connectionState.rawValue), queue size=\(pendingOnConnected.count + 1))")
        pendingOnConnected.append(block)
    }

    /// Drain every block in `pendingOnConnected` in FIFO order. Called by
    /// `handleSnapshot` after it flips `connectionState` to `.connected`,
    /// so any block that re-checks the state sees the new value.
    ///
    /// Copies the array to a local before clearing so that re-entrant
    /// calls to `runWhenConnected` (a drained block enqueueing another
    /// block) don't lose work: those new blocks, having seen
    /// `connectionState == .connected`, run immediately rather than
    /// landing back in the queue we're iterating.
    func drainPendingOnConnected() {
        guard !pendingOnConnected.isEmpty else { return }
        let pending = pendingOnConnected
        pendingOnConnected.removeAll(keepingCapacity: true)
        DiagnosticLog.log("RUN-WHEN-CONNECTED: draining \(pending.count) pending")
        for block in pending {
            block()
        }
    }

    /// Discard every queued block without running it. Called by
    /// `disconnect()` so a hard reset (switch desktop, unpair) doesn't
    /// leave stale resume commands waiting to fire against a new
    /// pairing's transport.
    func clearPendingOnConnected() {
        guard !pendingOnConnected.isEmpty else { return }
        DiagnosticLog.log("RUN-WHEN-CONNECTED: cleared \(pendingOnConnected.count) pending on disconnect")
        pendingOnConnected.removeAll(keepingCapacity: false)
    }

    // MARK: - Essential deferred queue (keyed, deduped)

    /// Enqueue a `.automaticEssential` command deduped by `key`. Called by
    /// `send(_:intent:)` when the connection state is not `.connected`.
    ///
    /// If an entry for `key` already exists, it is superseded (last-write-wins):
    /// the stale intent is replaced with the new command and a log entry notes
    /// the supersession. This prevents a reconnect from replaying a
    /// `loadConversation` for a tab the user navigated away from.
    func enqueueEssential(key: String, command: RemoteCommand) {
        if let existing = pendingEssentialQueue.firstIndex(where: { $0.key == key }) {
            DiagnosticLog.log(
                "ESSENTIAL-QUEUE: supersede key=\(key) depth=\(pendingEssentialQueue.count) conn=\(connectionState.rawValue)"
            )
            pendingEssentialQueue[existing] = (key: key, command: command)
        } else {
            pendingEssentialQueue.append((key: key, command: command))
            DiagnosticLog.log(
                "ESSENTIAL-QUEUE: enqueue key=\(key) depth=\(pendingEssentialQueue.count) conn=\(connectionState.rawValue)"
            )
        }
    }

    /// Drain the essential queue in FIFO order (preserving the intent order for
    /// distinct keys). Called by `handleSnapshot` immediately after
    /// `drainPendingOnConnected()`, once `connectionState` is already `.connected`.
    ///
    /// Sends directly via the transport (if available). In the unlikely event
    /// that the transport is nil at drain time (e.g. a race where the transport
    /// tore down between the snapshot arriving and the drain running), the
    /// command is logged and dropped -- not re-enqueued, to avoid an infinite
    /// defer cycle. The next snapshot will re-trigger the call site that
    /// originally enqueued the command.
    func drainPendingEssential() {
        guard !pendingEssentialQueue.isEmpty else { return }
        let pending = pendingEssentialQueue
        pendingEssentialQueue.removeAll(keepingCapacity: true)
        DiagnosticLog.log(
            "ESSENTIAL-QUEUE: flush \(pending.count) deferred commands on connect"
        )
        guard let transport else {
            DiagnosticLog.log("ESSENTIAL-QUEUE: drain skipped -- no transport (dropped \(pending.count) commands)")
            return
        }
        for entry in pending {
            DiagnosticLog.log("ESSENTIAL-QUEUE: flush key=\(entry.key)")
            DiagnosticLog.logCommand(entry.command)
            Task { [weak self] in
                do {
                    try await transport.send(entry.command)
                } catch {
                    DiagnosticLog.log("ESSENTIAL-QUEUE: flush send error key=\(entry.key): \(error.localizedDescription)")
                }
                _ = self
            }
        }
    }

    /// Discard the essential queue without sending. Called by `disconnect()`
    /// so stale intent for one desktop does not fire against a different pairing.
    func clearPendingEssential() {
        guard !pendingEssentialQueue.isEmpty else { return }
        DiagnosticLog.log(
            "ESSENTIAL-QUEUE: cleared \(pendingEssentialQueue.count) pending on disconnect"
        )
        pendingEssentialQueue.removeAll(keepingCapacity: false)
    }
}
