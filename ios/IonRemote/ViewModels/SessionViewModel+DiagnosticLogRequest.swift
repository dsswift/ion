import Foundation

// MARK: - Diagnostic log request
//
// The server pulls this phone's own log lines; this answers the pull.

extension SessionViewModel {

    /// Batches one pull may upload back to back before it leaves the rest to
    /// the next pull, so a long backlog never monopolizes a pull.
    static let maxDiagnosticBatchesPerPull = 40

    // MARK: - Diagnostic log request

    /// Answers a pull with the lines past `sinceSeq`, a batch at a time.
    ///
    /// One upload runs at a time. A pull that arrives while one is sending is
    /// skipped: the server asks again on its interval, from whatever cursor
    /// the upload left it. Each batch waits for the server's answer before
    /// the next, so the phone's outbound link always has room for the calls
    /// the person is making.
    @MainActor
    func handleRequestDiagnosticLogs(sinceSeq: Int = 0) {
        guard !diagnosticUploadInFlight else {
            DiagnosticLog.log("diagnostic export skipped: an upload is still sending", tag: "session", level: .debug, fields: [
                "since_seq": String(sinceSeq)
            ])
            return
        }
        // Filter on the id the live transport serves — the same value the
        // transport's didSet stamped onto the lines being exported.
        guard let transport, let pairingId = transport.deviceId ?? activeDevice?.id else {
            DiagnosticLog.log("diagnostic export skipped: no pairing", tag: "session", level: .warn, fields: [
                "since_seq": String(sinceSeq)
            ])
            return
        }
        diagnosticUploadInFlight = true
        // The export runs on DiagnosticLog's writeQueue, never the main actor.
        Task { @MainActor [weak self] in
            defer { self?.diagnosticUploadInFlight = false }
            var since = sinceSeq
            for batch in 1...Self.maxDiagnosticBatchesPerPull {
                let export = await DiagnosticLog.exportIncrementalSince(sinceSeq: since, pairingId: pairingId)
                // Withheld lines are passed over for good (the cursor is global),
                // so that outcome is logged at a level that ships.
                let withheld = export.withheldUnstamped + export.withheldOtherPairing
                DiagnosticLog.log("diagnostic export", tag: "session", level: withheld > 0 ? .warn : .debug, fields: [
                    "since_seq": String(since),
                    "next_seq": String(export.nextSeq),
                    "pairing_id": pairingId,
                    "batch": String(batch),
                    "bytes": String(export.logs.utf8.count),
                    "more": String(export.more),
                    "withheld_unstamped": String(export.withheldUnstamped),
                    "withheld_other_pairing": String(export.withheldOtherPairing)
                ])
                let response = RemoteCommand.diagnosticLogsResponse(
                    logs: export.logs,
                    pairingId: pairingId,
                    nextSeq: export.nextSeq,
                    withheldUnstamped: export.withheldUnstamped,
                    withheldOtherPairing: export.withheldOtherPairing
                )
                DiagnosticLog.logCommand(response)
                do {
                    try await transport.sendAwaitingAnswer(response)
                } catch {
                    // The server's cursor did not move; its next pull asks for these lines again.
                    DiagnosticLog.log("diagnostic upload failed", tag: "session", level: .warn, fields: [
                        "since_seq": String(since), "batch": String(batch), "error": error.localizedDescription
                    ])
                    return
                }
                guard export.more else { return }
                since = export.nextSeq
            }
            DiagnosticLog.log("diagnostic upload paused: batch limit reached, the next pull continues", tag: "session", fields: [
                "next_since_seq": String(since)
            ])
        }
    }
}
