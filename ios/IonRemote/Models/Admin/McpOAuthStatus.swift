import Foundation

/// The OAuth client configured for one MCP server, as `mcp.list` reports it.
/// Empty fields come from the server's discovery metadata at sign-in. The
/// secret itself never reaches the phone; `hasClientSecret` says one is stored.
struct McpOAuthStatus: Codable, Equatable, Sendable {
    let clientId: String?
    let authUrl: String?
    let tokenUrl: String?
    let scope: String?
    let resource: String?
    let hasClientSecret: Bool?
}
