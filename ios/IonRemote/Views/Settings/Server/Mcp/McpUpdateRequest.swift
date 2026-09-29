import Foundation

/// A change to one existing MCP server as the Edit sheet builds it. Only what
/// changed is sent; the engine keeps every setting the request does not name.
struct McpUpdateRequest: Equatable {
    let name: String
    var url: String?
    var command: String?
    var args: [String]?
    var oauth: McpOAuthSettings?

    /// The request for what the person changed, or the sentence saying what to fix.
    static func validate(server: McpServerStatus, endpoint rawEndpoint: String, oauth: McpOAuthDraft) -> Result<McpUpdateRequest, McpAddRequest.Invalid> {
        let endpoint = rawEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        var request = McpUpdateRequest(name: server.name)
        if server.transport == "stdio" {
            if endpoint.isEmpty { return .failure(McpAddRequest.Invalid("Enter the command to run.")) }
            let parts = endpoint.split(whereSeparator: \.isWhitespace).map(String.init)
            if parts[0] != server.command { request.command = parts[0] }
            let args = Array(parts.dropFirst())
            if args != (server.args ?? []) { request.args = args }
            return .success(request)
        }
        if endpoint.isEmpty { return .failure(McpAddRequest.Invalid("Enter the server URL.")) }
        guard McpOAuthDraft.isHttpURL(endpoint) else { return .failure(McpAddRequest.Invalid("The URL must start with http:// or https://")) }
        if let problem = oauth.problem() { return .failure(McpAddRequest.Invalid(problem)) }
        if endpoint != server.url { request.url = endpoint }
        request.oauth = oauth.settings(editing: true)
        return .success(request)
    }

    var jsonValue: JSONValue {
        var fields: [String: JSONValue] = ["name": .string(name)]
        if let url { fields["url"] = .string(url) }
        if let command { fields["command"] = .string(command) }
        if let args { fields["args"] = .array(args.map(JSONValue.string)) }
        if let oauth { fields["oauth"] = oauth.jsonValue }
        return .object(fields)
    }
}
