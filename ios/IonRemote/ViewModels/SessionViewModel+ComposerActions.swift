import Foundation

// MARK: - Composer Actions

extension SessionViewModel {
    /// The Composer Actions the server offers in this conversation, as the
    /// last snapshot carried them. Empty when it offers none.
    func composerActions(tabId: String) -> [ComposerAction] {
        tab(for: tabId)?.composerActions ?? []
    }

    /// Run a Composer Action: send its slash command through the same submit
    /// path a typed command takes, so the server resolves it to the extension
    /// that registered it.
    @MainActor
    func runComposerAction(tabId: String, action: ComposerAction) {
        DiagnosticLog.log("composer action chosen", tag: "session", level: .info, fields: [
            "tab_id": String(tabId.prefix(8)),
            "action_id": action.id,
            "producer": action.producer,
            "command": action.command,
        ])
        submit(tabId: tabId, text: action.command)
    }
}
