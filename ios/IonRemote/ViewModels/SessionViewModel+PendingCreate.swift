import Foundation

// MARK: - Tab-create delivery confirmation (confirm-or-resend)
//
// Tab-create commands (`createTab`, `createTerminalTab`) are the only
// user-actions with no delivery guarantee. Prompts and essential commands are
// protected by the essential queue (deferred while not-connected, requeued on a
// throw). Creates were not: they carry no `essentialKey`, and — critically —
// the failure that loses them does NOT throw. After a background/resume cycle
// the transport can report `.lanPreferred` / connected while the LAN socket is
// actually dead; `lan.send` writes into that zombie socket, succeeds locally,
// and the frame never reaches the desktop. No throw means no requeue, and a
// snapshot re-sync only reconciles desktop→iOS state — it cannot replay a lost
// outbound command. The create simply vanishes.
//
// This tracker closes the hole with end-to-end confirmation: every create is
// recorded as pending under a client-generated `clientCmdId`, sent best-effort,
// and RESENT (on a short timeout and on the next `.connected` transition) until
// the desktop echoes the id back on `desktop_tab_created` (`confirmCreate`). The
// desktop dedupes by `clientCmdId`, so a resend of a create that actually
// landed re-emits the existing tab rather than spawning a duplicate.

extension SessionViewModel {

    /// One in-flight create awaiting confirmation.
    struct PendingCreate {
        let command: RemoteCommand
        let clientCmdId: String
        var attempts: Int
        var timeoutTask: Task<Void, Never>?
    }

    /// How long to wait for a `desktop_tab_created` echo before resending.
    static let createResendTimeout: Duration = .seconds(4)
    /// Maximum send attempts before surfacing a visible failure.
    static let createMaxAttempts = 3

    /// Send a create command with delivery tracking. Records it as pending,
    /// fires a best-effort immediate send, and arms the resend timeout. This is
    /// the create-only replacement for `send(_:intent: .userInitiated)`, whose
    /// fire-once semantics silently drop a create into a wedged transport.
    func sendTrackedCreate(_ command: RemoteCommand, clientCmdId: String) {
        DiagnosticLog.logCommand(command)
        pendingCreates[clientCmdId] = PendingCreate(command: command, clientCmdId: clientCmdId, attempts: 1, timeoutTask: nil)
        attemptCreateSend(command)
        scheduleCreateTimeout(clientCmdId: clientCmdId)
    }

    /// Best-effort transmit. Delivery is guaranteed by confirm-or-resend, not by
    /// this send succeeding, so neither a missing transport nor a throw is
    /// surfaced to the user here — the timeout / reconnect resend covers both.
    private func attemptCreateSend(_ command: RemoteCommand) {
        guard let transport else {
            DiagnosticLog.log("tracked create: no transport, deferred to resend", tag: "session.create", fields: [:])
            return
        }
        Task { [weak self] in
            do {
                try await transport.send(command)
            } catch {
                DiagnosticLog.log("tracked create: immediate send failed, will resend", tag: "session.create", level: .warn, fields: [
                    "error": error.localizedDescription
                ])
                _ = self
            }
        }
    }

    /// (Re)arm the per-create timeout. Cancels any prior timer for this id so a
    /// resend doesn't leave two timers racing.
    private func scheduleCreateTimeout(clientCmdId: String) {
        pendingCreates[clientCmdId]?.timeoutTask?.cancel()
        let task = Task { [weak self] in
            try? await Task.sleep(for: SessionViewModel.createResendTimeout)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.onCreateTimeout(clientCmdId: clientCmdId) }
        }
        pendingCreates[clientCmdId]?.timeoutTask = task
    }

    /// Timeout elapsed with no confirmation: resend, or give up (with a visible
    /// toast) after `createMaxAttempts`. Runs on the main actor (it surfaces a
    /// toast via the `@MainActor` `showToast`).
    @MainActor
    func onCreateTimeout(clientCmdId: String) {
        guard var pending = pendingCreates[clientCmdId] else { return }  // already confirmed
        guard pending.attempts < SessionViewModel.createMaxAttempts else {
            DiagnosticLog.log("tracked create: gave up after max attempts", tag: "session.create", level: .error, fields: [
                "attempts": String(pending.attempts)
            ])
            pendingCreates.removeValue(forKey: clientCmdId)
            showToast(ToastMessage(style: .error, title: "Couldn't create tab", detail: "Not connected — try again"))
            return
        }
        pending.attempts += 1
        pendingCreates[clientCmdId] = pending
        DiagnosticLog.log("tracked create: resend on timeout", tag: "session.create", level: .warn, fields: [
            "attempt": String(pending.attempts)
        ])
        attemptCreateSend(pending.command)
        scheduleCreateTimeout(clientCmdId: clientCmdId)
    }

    /// Clear the pending entry for a confirmed create. Called from the
    /// `desktop_tab_created` handler. Returns `true` if it matched a local
    /// pending create, so the caller can drive navigation to the new tab.
    @discardableResult
    func confirmCreate(clientCmdId: String?) -> Bool {
        guard let clientCmdId, let pending = pendingCreates[clientCmdId] else { return false }
        pending.timeoutTask?.cancel()
        pendingCreates.removeValue(forKey: clientCmdId)
        DiagnosticLog.log("tracked create: confirmed", tag: "session.create", fields: [:])
        return true
    }

    /// Resend every still-pending create. Called on the `.connected` transition
    /// (the `handleSnapshot` drain seam) so a create issued while the transport
    /// was wedged/reconnecting delivers immediately on recovery instead of
    /// waiting out its timeout.
    func resendPendingCreates() {
        guard !pendingCreates.isEmpty else { return }
        DiagnosticLog.log("tracked create: resending on connect", tag: "session.create", fields: [
            "count": String(pendingCreates.count)
        ])
        for pending in pendingCreates.values {
            attemptCreateSend(pending.command)
        }
    }

    /// Cancel and discard all pending creates. Called on hard disconnect /
    /// unpair (`wipeTransientState`) so a stale create never spawns a tab
    /// against a different pairing. Survives soft reconnect by construction —
    /// only the hard-reset path clears it.
    func clearPendingCreates() {
        guard !pendingCreates.isEmpty else { return }
        for pending in pendingCreates.values { pending.timeoutTask?.cancel() }
        DiagnosticLog.log("tracked create: cleared on disconnect", tag: "session.create", fields: [
            "count": String(pendingCreates.count)
        ])
        pendingCreates.removeAll()
    }
}
