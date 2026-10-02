import Foundation

/// One MCP server the server's engine is configured with, as `mcp.list` and
/// the `ion:mcp-servers-changed` snapshot report it.
///
/// Connected and authorized are separate: a server that holds a token but is
/// not connected is refusing it.
struct McpServerStatus: Codable, Equatable, Identifiable, Sendable {
    let name: String
    /// `http`, `sse`, or `stdio`. Absent from an engine that does not report it.
    let transport: String?
    let url: String?
    let command: String?
    /// Stdio server arguments; absent for network transports.
    var args: [String]?
    /// The configured OAuth client; absent when the server relies on discovery.
    var oauth: McpOAuthStatus?
    let connected: Bool
    let authenticated: Bool
    let toolCount: Int?
    let lastError: String?
    /// The organization's managed engine file defines this server, so it
    /// cannot be edited or removed. Absent means it can.
    var managed: Bool?

    var id: String { name }
}
