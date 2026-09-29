import Foundation

/// A new MCP server as the Add sheet builds it: a remote URL, optionally with
/// an OAuth client, or a local command split into the executable and its
/// arguments.
struct McpAddRequest: Equatable {
    enum Kind: String, CaseIterable, Identifiable {
        case remote, local
        var id: String { rawValue }
        var label: String { self == .remote ? "Remote URL" : "Local command" }
    }

    let name: String
    let url: String?
    let command: String?
    let args: [String]
    var oauth: McpOAuthSettings?

    /// The request for what the person typed, or the sentence saying what to
    /// fix. Mirrors the engine's own name rule so a mistake is caught here:
    /// `__` separates server and tool names.
    static func validate(kind: Kind, name rawName: String, endpoint rawEndpoint: String, oauth: McpOAuthDraft = McpOAuthDraft()) -> Result<McpAddRequest, McpAddRequest.Invalid> {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = rawEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return .failure(Invalid("Enter a name for the server.")) }
        if name.rangeOfCharacter(from: .whitespacesAndNewlines) != nil { return .failure(Invalid("The name cannot contain spaces.")) }
        if name.contains("__") { return .failure(Invalid("The name cannot contain \"__\" (it separates server and tool names).")) }
        if endpoint.isEmpty { return .failure(Invalid(kind == .remote ? "Enter the server URL." : "Enter the command to run.")) }
        switch kind {
        case .remote:
            let lower = endpoint.lowercased()
            guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else {
                return .failure(Invalid("The URL must start with http:// or https://"))
            }
            if let problem = oauth.problem() { return .failure(Invalid(problem)) }
            return .success(McpAddRequest(name: name, url: endpoint, command: nil, args: [], oauth: oauth.settings(editing: false)))
        case .local:
            let parts = endpoint.split(whereSeparator: \.isWhitespace).map(String.init)
            return .success(McpAddRequest(name: name, url: nil, command: parts[0], args: Array(parts.dropFirst())))
        }
    }

    struct Invalid: Error, Equatable {
        let message: String
        init(_ message: String) { self.message = message }
    }
}
