import Foundation

// MARK: - Engine Commands
//
// Extracted from SessionViewModel+Commands.swift to keep that file under the
// Swift 600-line cap. See CLAUDE.md → "When a file exceeds the cap": split
// along natural seams rather than collapsing comments. These methods are a
// cohesive group of engine-default / dialog / abort commands.
//
// #256 follow-up: the former `submitEnginePrompt`, `setTabModel(tabId:model:)`,
// and `setEngineModel(tabId:model:)` methods were REMOVED from this file. They
// were the engine/plain code forks behind `submit` / `setModel`. Both submit
// paths and both setModel paths are now collapsed into the single, branch-free
// `submit` / `setModel` in SessionViewModel+Commands.swift, which emit one wire
// command each (`desktop_prompt` with optional `instanceId`, and
// `desktop_set_tab_model`). The per-tab `instanceId` field is the only DATA
// difference on submit; setModel uses the single `desktop_set_tab_model`
// command for every tab (the desktop applies it to the active conversation
// instance regardless of tab type). Deleting the dead per-tab variants here
// prevents the divergence from silently regrowing.

extension SessionViewModel {

    func setPreferredModelDefault(_ model: String) {
        preferredModel = model
        send(.setPreferredModel(model: model), intent: .userInitiated)
    }

    func setEngineDefaultModelDefault(_ model: String) {
        engineDefaultModel = model
        send(.setEngineDefaultModel(model: model), intent: .userInitiated)
    }

    func abortEngine(tabId: String) {
        let instanceId = activeEngineInstance[tabId]
        send(.engineAbort(tabId: tabId, instanceId: instanceId), intent: .userInitiated)
    }

    func respondEngineDialog(tabId: String, dialogId: String, value: String) {
        engineDialogs[tabId] = nil
        let instanceId = activeEngineInstance[tabId]
        send(.engineDialogResponse(tabId: tabId, dialogId: dialogId, value: value, instanceId: instanceId), intent: .userInitiated)
    }
}
