import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Plan→Implement Flow
//
// This file owns iOS's side of the plan-approval → implement-phase
// transition. It's split out of SessionViewModel+Commands.swift to keep
// that file under the 600-line Swift cap (see CLAUDE.md → "When a file
// exceeds the cap"). The seam is natural: the implement-plan flow is a
// self-contained unit with one entry point (`implementPlan`) and one
// concern (handing off from plan mode to implementation, optionally with
// a fresh conversation).
//
// Desktop counterpart: usePermissionDeniedHandlers.ts::onImplement and
// EngineView.tsx::handleImplement.

extension SessionViewModel {

    /// Switch to auto mode and send the implementation prompt in a single
    /// ordered Task so the mode change is guaranteed to arrive at the desktop
    /// before the prompt. Without this, two separate `Task {}` blocks can
    /// race and the prompt may arrive while the engine is still in plan mode.
    ///
    /// Engine tabs route through `.enginePrompt` (which the desktop dispatches
    /// to `handleEnginePrompt` → the engine instance), not `.prompt` (which
    /// goes to `handlePrompt` → the CLI session plane). Without this split,
    /// tapping "Implement" on an engine-view plan card sends a CLI prompt
    /// that never reaches the engine instance — the card disappears but
    /// nothing happens.
    ///
    /// `clearContext` controls whether the implement run starts in a fresh
    /// engine session (the historical behavior) or preserves the planning
    /// conversation. Default is `false` — the regular Implement action keeps
    /// the conversation so the model retains everything it learned during
    /// planning. The secondary "Implement, clear context" button (revealed
    /// only when the desktop's `showImplementClearContext` setting is on)
    /// passes `true` here, restoring the reset-and-archive behavior. The
    /// engine-side `implementationPhase=true` flag is set regardless of
    /// `clearContext`, because the engine concern (don't let the model
    /// re-propose plan mode) applies to both branches.
    ///
    /// When `clearContext == true`, the reset command sent to the desktop
    /// depends on the tab kind:
    ///
    ///   - CLI tabs send `.resetTabSession(tabId)`, which the desktop
    ///     routes to `sessionPlane.resetTabSession()` → `bridge.stopSession(tabId)`.
    ///   - Engine tabs send `.resetEngineSession(tabId, instanceId)`, which
    ///     the desktop routes to `handleResetEngineSession` →
    ///     `bridge.stopSession(`${tabId}:${instanceId}`)` and a renderer
    ///     IPC that wipes per-instance state Maps.
    ///
    /// Both reset paths leave the tab/instance entry intact and seed a
    /// fresh "Session started" divider so the user sees where the reset
    /// boundary fell. CLI and engine tabs are now symmetric — earlier
    /// versions of this file documented an "engine-tab caveat" because
    /// `resetTabSession` only addressed the CLI plane; that gap is closed
    /// by the dedicated `reset_engine_session` wire command.
    func implementPlan(tabId: String, prompt: String, clearContext: Bool = false) {
        let hasEngineExtension = tabs.first(where: { $0.id == tabId })?.hasEngineExtension == true
        let instanceId = hasEngineExtension ? activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id : nil
        // Optimistic local update for responsive UI
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].permissionMode = .auto
            tabs[idx].status = .connecting
        }
        guard let transport else {
            Task { @MainActor [weak self] in
                self?.showToast(ToastMessage(style: .error, title: "Not connected", detail: "Command could not be sent"))
            }
            return
        }
        Task { [weak self] in
            do {
                if clearContext {
                    // Opt-in: reset the engine session so the implementation
                    // run starts clean — clears plan mode, conversation
                    // history, and the restricted tool list. Matches the
                    // desktop's onImplement(true) flow.
                    //
                    // Engine tabs get the dedicated `reset_engine_session`
                    // wire command which carries the instanceId and routes
                    // to `bridge.stopSession(`${tabId}:${instanceId}`)` on
                    // the desktop. CLI tabs continue to use `reset_tab_session`
                    // which addresses the CLI session plane.
                    if hasEngineExtension, let instanceId {
                        ionLog.info("implementPlan: tabId=\(tabId.prefix(8), privacy: .public) instanceId=\(instanceId.prefix(8), privacy: .public) clearContext=true — sending resetEngineSession")
                        try await transport.send(.resetEngineSession(tabId: tabId, instanceId: instanceId))
                    } else {
                        ionLog.info("implementPlan: tabId=\(tabId.prefix(8), privacy: .public) clearContext=true — sending resetTabSession")
                        try await transport.send(.resetTabSession(tabId: tabId))
                    }
                } else {
                    // Default: preserve the conversation. The
                    // setPermissionMode below drops plan-mode state on the
                    // engine without destroying the session, and the
                    // implementationPhase flag suppresses EnterPlanMode
                    // tool injection so the model can't re-enter plan
                    // mode against the user's intent.
                    ionLog.info("implementPlan: tabId=\(tabId.prefix(8), privacy: .public) clearContext=false — preserving conversation")
                }
                // Set permission mode to auto. When clearContext=true this
                // hits a fresh session (the reset above replaced the
                // engine session). When false this just flips plan mode
                // off on the existing session.
                try await transport.send(.setPermissionMode(tabId: tabId, mode: .auto))
                // Send the implementation prompt with implementationPhase
                // flag so the engine suppresses EnterPlanMode injection.
                if hasEngineExtension {
                    try await transport.send(.enginePrompt(tabId: tabId, text: prompt, instanceId: instanceId, implementationPhase: true))
                } else {
                    try await transport.send(.prompt(tabId: tabId, text: prompt, implementationPhase: true))
                }
            } catch {
                let detail = error.localizedDescription
                await MainActor.run {
                    self?.showToast(ToastMessage(style: .error, title: "Send failed", detail: detail))
                }
            }
        }
    }
}
