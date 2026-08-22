import Foundation

/// Per-tab status string. Mirrors the Go-side `tabStatus` value emitted
/// on `RemoteTabState.status` (see `desktop/src/main/remote/protocol.ts`)
/// and the renderer-side `tab.status` field. The string values match
/// the wire exactly; renaming would break wire compatibility.
///
/// State machine:
///   - `connecting`: optimistic state set when a prompt is submitted
///     and cleared when the engine responds with run_start or any
///     terminal event.
///   - `idle`: no run is in flight.
///   - `starting`: engine startup is in progress. This is distinct from a
///     running turn, so status surfaces use the still idle color.
///   - `running`: at least one run is in flight.
///   - `completed`: run finished cleanly, possibly with an unresolved
///     AskUserQuestion / ExitPlanMode permission denial still on the
///     tab. UI surfaces a waiting pill.
///   - `failed`: terminal error (provider 5xx, auth failure, etc.).
///   - `dead`: engine process terminated (Phase 4 of the
///     state-management overhaul; the desktop reflects this on tabs
///     whose engine session can no longer be resumed).
enum TabStatus: String, Codable, Sendable {
    case connecting, idle, starting, running, waiting, completed, failed, dead
}
