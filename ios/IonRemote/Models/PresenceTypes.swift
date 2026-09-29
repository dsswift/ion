import Foundation

/// FR-02: who is connected to this environment and which tab they have
/// focused. Mirrors `packages/shared/src/types-presence.ts` (TypeScript
/// origin, not the Go engine -- see AGENTS.md's contract-sync rules, which
/// this event is outside of). Desktop↔iOS wire (ADR-008), lockstep.
struct PresenceEntry: Codable, Equatable, Identifiable {
    var id: String { subject }
    let subject: String
    let displayName: String
    let focusedTabId: String?
}
