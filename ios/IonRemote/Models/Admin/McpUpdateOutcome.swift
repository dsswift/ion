import Foundation

/// What `mcp.update` reports: whether anything changed, and whether the
/// server's stored sign-in was dropped because its URL or OAuth client changed.
struct McpUpdateOutcome: Decodable, Equatable, Sendable {
    let changed: Bool?
    let credentialsCleared: Bool?
}
