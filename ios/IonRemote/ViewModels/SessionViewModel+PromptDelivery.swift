import Foundation

extension SessionViewModel {

    /// Handles desktop_engine_rewind_result — sent ONLY when the desktop's
    /// transactional rewind was REJECTED by the engine (unknown/foreign-branch/
    /// non-user target). A successful rewind stays silent (observable through
    /// the existing history/prefill push); without this handler a refused
    /// rewind left the user with an unchanged transcript and zero feedback
    /// that the tap did anything.
    @MainActor
    func handleEngineRewindResult(tabId: String, instanceId: String, error: String?) {
        DiagnosticLog.log("engine rewind rejected", tag: "session.commands", level: .warn, fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": String(instanceId.prefix(8)),
            "error": error ?? "",
        ])
        showToast(ToastMessage(style: .error, title: "Rewind not applied", detail: error ?? "Server rejected this rewind"))
    }
}
