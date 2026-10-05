import Foundation

/// The last plan-mode change the engine refused on a conversation's active
/// instance. The server has already put `permissionMode` back; this says why
/// the toggle reverted. Absent when nothing was refused or a later change
/// succeeded. Mirrors `PlanModeRejection` in `packages/shared/src/types-engine.ts`.
struct PlanModeRejection: Codable, Equatable, Sendable {
    /// The mode that was asked for: true for plan, false for auto.
    let requestedEnabled: Bool
    /// The handler's explanation; may be empty.
    let reason: String
    /// "wire" (a client toggle) or "extension".
    let source: String
    /// Epoch ms when the rejection arrived.
    let at: Double
}
