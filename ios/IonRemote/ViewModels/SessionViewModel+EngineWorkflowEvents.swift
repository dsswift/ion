import Foundation

// MARK: - Engine Workflow Event Handlers (observe-only)
//
// Extracted from SessionViewModel+EventHandlers.swift to keep that file
// under the 600-line cap and to give the cluster of observe-only engine
// workflow events one home.
//
// These events arrive from the desktop (which is the authoritative consumer
// for all of them) purely so the wire protocol stays uniform across consumers
// — every engine event the desktop sees, iOS sees. iOS does not act on any
// of them today; each handler exists so the switch in `handleEvent(_:)`
// stays exhaustive and so future iOS features that *do* want to render UI
// for these events have a single, well-known place to add behavior.
//
// Current events handled:
//   - enginePlanProposal             — workflow signal that the model has
//                                      proposed a plan-mode transition
//                                      (currently only kind="exit"). Desktop
//                                      gates the actual mode flip via its
//                                      approval UI; see ADR-003.
//   - engineEarlyStopDecisionRequest — engine ↔ harness wire-protocol
//                                      request emitted when the engine wants
//                                      an external opinion on whether to
//                                      nudge a model that has stopped below
//                                      the configured output-token budget.
//                                      Desktop's early-stop-policy.ts
//                                      responds via the
//                                      early_stop_decision_response command;
//                                      see ADR-002.
//   - engineCommandRegistry          — complete snapshot of slash commands
//                                      exposed by the session's loaded
//                                      extensions. Desktop's prompt pipeline
//                                      uses this as a routing-hint cache;
//                                      iOS does not yet consume the registry
//                                      for autocomplete (intentionally out
//                                      of scope for the unified slash-
//                                      pipeline phase).
//   - engineCommandResult            — fired at the end of every
//                                      Manager.SendCommand dispatch.
//                                      Desktop awaits it to decide between
//                                      "dispatch landed" and "engine
//                                      disclaims, fall through to .md
//                                      expansion".
//
// Diagnostic visibility: DiagnosticLog.logEvent fires for every event the
// switch dispatches, so these handlers don't need to log anything. Add
// per-handler logging only if a real behavior change requires it.

extension SessionViewModel {

    @MainActor
    func handleEnginePlanProposal() {
        // Workflow event from the engine: the model has proposed a
        // plan-mode transition (currently only kind="exit"). iOS does
        // not yet render an approval UI for this — the desktop is the
        // authoritative consumer that gates the actual mode flip — so
        // we observe the event for diagnostic visibility (handled by
        // DiagnosticLog.logEvent in handleEvent) and otherwise no-op.
        // The wire protocol stays uniform across consumers. See
        // docs/architecture/adr/003-state-events-vs-workflow-events.md.
    }

    @MainActor
    func handleEngineEarlyStopDecisionRequest() {
        // Engine ↔ harness wire-protocol request emitted when the
        // engine wants an external opinion on whether to nudge a
        // model that has stopped below the configured output-token
        // budget. The desktop's early-stop-policy.ts is the
        // authoritative responder via the early_stop_decision_response
        // command. iOS does not respond — it observes the event for
        // diagnostic visibility (handled by DiagnosticLog.logEvent in
        // handleEvent) and otherwise no-ops.
        //
        // Decoding the event cleanly on iOS keeps the wire protocol
        // uniform: every engine event the desktop sees, iOS sees.
        // The previous desktop-side filter that skipped this event
        // before forwarding to iOS is now removed in
        // desktop/src/main/event-wiring.ts. See ADR-002 for the
        // engine-vs-harness boundary that motivates the request /
        // response shape on the wire.
    }

    @MainActor
    func handleEngineCommandRegistry() {
        // Complete snapshot of slash commands exposed by the session's
        // loaded extensions. Desktop's prompt pipeline uses this as a
        // routing-hint cache (engine-command names take precedence over
        // local .md template lookups). iOS does not yet consume the
        // registry for autocomplete — Phase 0.5 of the unified slash-
        // pipeline plan intentionally left the iOS UI out of scope.
        //
        // Snapshot semantics: when iOS does start consuming this, the
        // payload is a REPLACE-style snapshot, not an incremental
        // update. Empty `commands: []` is the authoritative "no
        // extension commands for this session" signal — not a no-op.
        // See docs/architecture/agent-state.md for the canonical
        // snapshot-replace pattern.
    }

    @MainActor
    func handleEngineCommandResult() {
        // Fired at the end of every Manager.SendCommand dispatch:
        // success (commandError empty), extension-command failure
        // (commandError = the error message), or unknown command
        // (commandError = "unknown_command"). Desktop awaits this
        // event in its prompt pipeline; iOS does not act on it today.
        //
        // The desktop also uses a specific success case
        // (command == "clear" && !commandError) to relay an iOS-
        // renderable divider via engine_harness_message /
        // message_added — that path lives in
        // desktop/src/main/event-wiring.ts, and iOS receives the
        // divider via those existing event types rather than by
        // interpreting engine_command_result directly. The wire
        // protocol stays uniform either way.
    }
}
