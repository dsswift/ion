import Foundation

/// A permission a Studio connection holds, granted by its pairing and repeated
/// in every welcome. Mirrors `Scope` in `packages/shared/src/studio-wire/types.ts`.
enum StudioScope: String, CaseIterable, Sendable {
    case conversationsRead = "conversations:read"
    case conversationsOperate = "conversations:operate"
    case terminalOperate = "terminal:operate"
    case gitWrite = "git:write"
    case admin

    /// True when `granted` satisfies this scope. `admin` satisfies every scope,
    /// as `scopeSatisfies` does on the server.
    func isSatisfied(by granted: [String]) -> Bool {
        granted.contains(rawValue) || granted.contains(StudioScope.admin.rawValue)
    }
}
