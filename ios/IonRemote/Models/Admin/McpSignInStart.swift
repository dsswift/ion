import Foundation

/// The answer to `mcp.login` with a `redirectUri`: the provider page to open,
/// and the flow the landing address is handed back to with `auth.completeSignIn`.
struct McpSignInStart: Codable, Equatable, Sendable {
    let authorizationUrl: String
    let flowId: String?
}
