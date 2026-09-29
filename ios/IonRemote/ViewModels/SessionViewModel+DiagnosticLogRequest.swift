import Foundation

// MARK: - Diagnostic log request
//
// The server pulls this phone's own log lines; this answers the pull.

extension SessionViewModel {

    // MARK: - Diagnostic log request

    @MainActor
    func handleRequestDiagnosticLogs(sinceSeq: Int = 0) {
        // One uniform path: sinceSeq=0 (full pull) filters seq > 0, which is
        // every line, so there is no special-case export branch. nextSeq is the
        // cursor the desktop persists and echoes on the next request.
        //
        // The export runs on DiagnosticLog's writeQueue — NOT the main actor.
        // The desktop pulls every 5 s; the old synchronous full-history rescan
        // (read all retained files, split, JSONSerialization per line — 4.4 MB
        // observed) on the main thread was watchdog-kill territory. We await
        // the background export and hop back to the main actor only to send.
        Task { @MainActor [weak self] in
            // Filter on the id the live transport serves — the same value the
            // transport's didSet stamped onto the lines being exported.
            guard let self, let pairingId = self.transport?.deviceId ?? self.activeDevice?.id else {
                DiagnosticLog.log("diagnostic export skipped: no pairing", tag: "session", level: .warn, fields: [
                    "since_seq": String(sinceSeq)
                ])
                return
            }
            let export = await DiagnosticLog.exportIncrementalSince(sinceSeq: sinceSeq, pairingId: pairingId)
            // Withheld lines are passed over for good (the cursor is global),
            // so that outcome is logged at a level that ships.
            let withheld = export.withheldUnstamped + export.withheldOtherPairing
            DiagnosticLog.log("diagnostic export", tag: "session", level: withheld > 0 ? .warn : .debug, fields: [
                "since_seq": String(sinceSeq),
                "next_seq": String(export.nextSeq),
                "pairing_id": pairingId,
                "withheld_unstamped": String(export.withheldUnstamped),
                "withheld_other_pairing": String(export.withheldOtherPairing)
            ])
            self.send(.diagnosticLogsResponse(
                logs: export.logs,
                pairingId: pairingId,
                nextSeq: export.nextSeq,
                withheldUnstamped: export.withheldUnstamped,
                withheldOtherPairing: export.withheldOtherPairing
            ), intent: .automaticEssential)
        }
    }
}
