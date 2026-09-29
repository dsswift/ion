import Foundation

/// The words the MCP screens use for a server's state.
enum McpServerText {

    /// Where the server lives: its URL, else its command.
    static func endpoint(_ server: McpServerStatus) -> String {
        if let url = server.url, !url.isEmpty { return url }
        return server.command ?? ""
    }

    static func connection(_ server: McpServerStatus) -> String {
        if server.connected { return "Connected" }
        return server.lastError == nil ? "Not connected" : "Not connected: last attempt failed"
    }

    /// "3 tools" while connected and offering some; else nil.
    static func toolCount(_ server: McpServerStatus) -> String? {
        guard server.connected, let count = server.toolCount, count > 0 else { return nil }
        return count == 1 ? "1 tool" : "\(count) tools"
    }
}
