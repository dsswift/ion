import Foundation

/// A slash command discovered from filesystem command/skill directories.
/// Mirrors the `DiscoveredCommand` interface in `types-events.ts`.
struct DiscoveredSlashCommand: Codable, Sendable, Identifiable {
    var id: String { name }
    let name: String
    let description: String
    let scope: String       // "user" | "project"
    let source: String      // "command" | "skill"
}
