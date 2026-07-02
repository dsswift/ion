import Foundation

/// Per-dispatch telemetry entry, mirroring the desktop's
/// `DispatchTelemetryEntry` in `shared/types-engine.ts`.
/// Accumulated on the iOS conversation-instance model via
/// `engineDispatchStart` / `engineDispatchEnd` events and
/// projected from the desktop snapshot via `dispatchTelemetry`.
struct DispatchTelemetryEntry: Codable, Sendable, Equatable, Identifiable {
    let dispatchAgent: String
    let dispatchSessionId: String
    let dispatchModel: String
    let dispatchTask: String
    let dispatchDepth: Int
    let dispatchParentId: String
    /// Stable unique id for this dispatch instance. Set from engine dispatchId field.
    let dispatchId: String
    /// Set once engine_dispatch_end arrives. The conversation id the dispatched agent used.
    var conversationId: String?
    /// Set once engine_dispatch_end arrives.
    var exitCode: Int?
    var elapsed: Double?
    var cost: Double?

    var id: String { dispatchId }
}
