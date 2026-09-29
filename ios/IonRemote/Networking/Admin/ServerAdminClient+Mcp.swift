import Foundation

/// The MCP servers section's calls. The engine owns the configuration, the
/// OAuth exchange, and the tokens; the phone only asks and hands back the
/// address a sign-in landed on.
extension ServerAdminClient {

    func listMcpServers() async throws -> [McpServerStatus] {
        let value = try await callOkEnvelope(.mcpList)
        return try member("servers", of: value, from: .mcpList, as: [McpServerStatus]?.self) ?? []
    }

    /// Adds a remote server by URL, or a local one by command and arguments.
    /// The engine infers the transport from which one is set. A remote server
    /// may carry an OAuth client; what it leaves out comes from discovery.
    func addMcpServer(name: String, url: String? = nil, command: String? = nil, args: [String] = [], oauth: McpOAuthSettings? = nil) async throws {
        var fields: [String: JSONValue] = ["name": .string(name)]
        if let url { fields["url"] = .string(url) }
        if let command { fields["command"] = .string(command) }
        if !args.isEmpty { fields["args"] = .array(args.map(JSONValue.string)) }
        if let oauth { fields["oauth"] = oauth.jsonValue }
        _ = try await callOkEnvelope(.mcpAdd, args: [.object(fields)])
    }

    /// Changes one server, keeping every setting the request does not name.
    func updateMcpServer(_ request: McpUpdateRequest) async throws -> McpUpdateOutcome {
        let value = try await callOkEnvelope(.mcpUpdate, args: [request.jsonValue])
        return try decodeAnswer(value, from: .mcpUpdate)
    }

    /// Removes the server and its stored credentials.
    func removeMcpServer(name: String) async throws {
        _ = try await callOkEnvelope(.mcpRemove, args: [.string(name)])
    }

    /// Drops the server's stored credentials, keeping its configuration.
    func signOutMcpServer(name: String) async throws {
        _ = try await callOkEnvelope(.mcpLogout, args: [.string(name)])
    }

    /// Begins a sign-in this phone finishes itself: the provider returns the
    /// browser to `redirectUri`, and that address goes to `completeSignIn`
    /// (`auth.completeSignIn`, shared with the provider sign-ins).
    func beginMcpSignIn(name: String, redirectUri: String) async throws -> McpSignInStart {
        let value = try await callOkEnvelope(.mcpLogin, args: [.string(name), .null, .object(["redirectUri": .string(redirectUri)])])
        return try decodeAnswer(value, from: .mcpLogin)
    }
}
