import Foundation

// MARK: - Engine run-recovery handler
//
// Mirrors the desktop renderer's run_recovery handling in event-slice.ts:
// started/completed phases are quiet (the recovery lifecycle is an internal
// engine concern), while failed/skipped/exhausted phases insert a system
// notice so the user knows recovery did not succeed.
extension SessionViewModel {
    @MainActor
    func handleEngineRunRecovery(
        tabId: String,
        instanceId: String?,
        recoveryId: String,
        phase: String,
        attempt: Int?,
        maxAttempts: Int?,
        reason: String?
    ) {
        switch phase {
        case "started", "completed":
            break

        case "failed", "skipped", "exhausted":
            let suffix = reason.map { ": \($0)" } ?? ""
            let content = "Automatic recovery \(phase)\(suffix)"
            let msg = Message(
                id: UUID().uuidString,
                role: .system,
                content: content,
                timestamp: Date().timeIntervalSince1970 * 1000
            )
            appendLiveMessage(tabId: tabId, instanceId: instanceId, msg)

        default:
            DiagnosticLog.log(
                "engineRunRecovery: unknown phase '\(phase)'",
                tag: "session",
                level: .warn
            )
        }
    }
}
