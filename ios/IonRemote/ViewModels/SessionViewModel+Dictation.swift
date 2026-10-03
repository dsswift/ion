import Foundation

// MARK: - Dictation into the composer draft
//
// The composer's dictation flow, from the mic tap to the words landing in the
// draft. `SpeechRecognitionService` owns the session (phase, base draft,
// engine); this extension is the one place that writes the result into the
// tab's draft, so the composer view holds no recording state of its own.
//
// Every write goes through `setEngineDraft`, which is the same path typing
// takes: the draft persists, syncs to the host on its debounce, and the
// pending-prompt machinery sees exactly what the operator sees.

extension SessionViewModel {

    /// Why a dictation did not start, for the composer to explain.
    enum DictationStartOutcome: Equatable {
        case started
        case permissionDenied
        case failed(String)
    }

    /// Open a dictation session for `tabId` on top of its current draft.
    ///
    /// Asks for permission when it has not been decided yet; a denial is
    /// returned rather than thrown so the composer can offer the Settings
    /// shortcut. The phase is `starting` across the permission prompt and the
    /// engine's audio setup, so the composer shows its dictation layout from
    /// the first tap instead of after a visible delay.
    @MainActor
    func startDictation(tabId: String) async -> DictationStartOutcome {
        speechService.refreshPermissions()
        if speechService.permissionState == .denied {
            DiagnosticLog.log("dictation refused; permission denied", tag: "session.dictation", level: .warn, fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            return .permissionDenied
        }
        if speechService.permissionState != .granted {
            let granted = await speechService.requestPermission()
            guard granted else {
                DiagnosticLog.log("dictation refused; permission request denied", tag: "session.dictation", level: .warn, fields: [
                    "tab_id": String(tabId.prefix(8))
                ])
                return .permissionDenied
            }
        }
        let base = tabDraft(tabId)
        do {
            try await speechService.beginDictation(baseDraft: base, stoppingVoiceService: voiceService)
        } catch {
            DiagnosticLog.log("dictation start failed", tag: "session.dictation", level: .error, fields: [
                "tab_id": String(tabId.prefix(8)),
                "error": error.localizedDescription
            ])
            return .failed(error.localizedDescription)
        }
        DiagnosticLog.log("dictation started", tag: "session.dictation", fields: [
            "tab_id": String(tabId.prefix(8)),
            "base_count": String(base.count)
        ])
        return .started
    }

    /// Mirror the live transcript into the draft while the session listens.
    /// Called by the composer whenever the service's transcript changes; a
    /// change that arrives in any other phase is the engine's tail landing
    /// after the session closed, and `finishDictation` already took it.
    @MainActor
    func syncDictationDraft(tabId: String) {
        guard speechService.phase == .listening else { return }
        setEngineDraft(tabId: tabId, instanceId: "", speechService.composedDraft)
    }

    /// Close the session and leave the finished words in the draft.
    @MainActor
    func finishDictation(tabId: String) async {
        let composed = await speechService.finishDictation()
        setEngineDraft(tabId: tabId, instanceId: "", composed)
        DiagnosticLog.log("dictation finished into draft", tag: "session.dictation", fields: [
            "tab_id": String(tabId.prefix(8)),
            "draft_count": String(composed.count)
        ])
    }

    /// Discard the session and put the pre-dictation draft back.
    @MainActor
    func cancelDictation(tabId: String) {
        let restore = speechService.cancelDictation()
        setEngineDraft(tabId: tabId, instanceId: "", restore)
        DiagnosticLog.log("dictation cancelled; draft restored", tag: "session.dictation", fields: [
            "tab_id": String(tabId.prefix(8)),
            "draft_count": String(restore.count)
        ])
    }

    /// The engine stopped on its own while the session was listening. Keep the
    /// words heard so far and close the session so the composer's layout
    /// follows the engine rather than a stale flag.
    @MainActor
    func dictationEngineEnded(tabId: String) {
        guard speechService.phase == .listening else { return }
        let composed = speechService.settleAfterEngineEnded()
        setEngineDraft(tabId: tabId, instanceId: "", composed)
        DiagnosticLog.log("dictation settled after engine ended", tag: "session.dictation", level: .warn, fields: [
            "tab_id": String(tabId.prefix(8)),
            "draft_count": String(composed.count)
        ])
    }
}
