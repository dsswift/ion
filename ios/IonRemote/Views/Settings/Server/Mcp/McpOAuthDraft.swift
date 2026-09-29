import Foundation

/// The OAuth client fields as the Add and Edit sheets hold them while the
/// person types. Every field is optional: blank ones come from the server's
/// discovery metadata at sign-in.
struct McpOAuthDraft: Equatable {
    var enabled = false
    var clientId = ""
    var clientSecret = ""
    var authUrl = ""
    var tokenUrl = ""
    var scope = ""
    var resource = ""
    /// The person chose to remove the stored secret.
    var secretRemoved = false
    /// The server already has a configured client (edits only).
    let hasStoredClient: Bool
    /// The server already stores a client secret (edits only).
    let hasStoredSecret: Bool

    init() {
        hasStoredClient = false
        hasStoredSecret = false
    }

    /// The draft for an edit, filled from what the server reports.
    init(status: McpOAuthStatus?) {
        enabled = status != nil
        clientId = status?.clientId ?? ""
        authUrl = status?.authUrl ?? ""
        tokenUrl = status?.tokenUrl ?? ""
        scope = status?.scope ?? ""
        resource = status?.resource ?? ""
        hasStoredClient = status != nil
        hasStoredSecret = status?.hasClientSecret == true
    }

    /// A stored secret that will be kept when the person saves.
    var keepsStoredSecret: Bool { hasStoredSecret && !secretRemoved && trimmed(clientSecret) == nil }

    /// The sentence saying what to fix, or nil. Mirrors the engine's rules: an
    /// endpoint or secret belongs to a client, and endpoints are http(s) URLs.
    func problem() -> String? {
        guard enabled else { return nil }
        if trimmed(clientId) == nil && (trimmed(authUrl) != nil || trimmed(tokenUrl) != nil || trimmed(clientSecret) != nil) {
            return "Enter the client ID. An authorization URL, token URL, or secret belongs to a client."
        }
        if let url = trimmed(authUrl), !Self.isHttpURL(url) { return "The authorization URL must start with http:// or https://" }
        if let url = trimmed(tokenUrl), !Self.isHttpURL(url) { return "The token URL must start with http:// or https://" }
        return nil
    }

    /// The client to send, or nil to send none (an add) or leave the stored one
    /// alone (an edit with the client off and none stored). Turning the client
    /// off on an edit clears the stored one, secret included.
    func settings(editing: Bool) -> McpOAuthSettings? {
        guard enabled else { return editing && hasStoredClient ? McpOAuthSettings(clientSecret: "") : nil }
        var settings = McpOAuthSettings(
            clientId: trimmed(clientId), authUrl: trimmed(authUrl), tokenUrl: trimmed(tokenUrl),
            scope: trimmed(scope), resource: trimmed(resource)
        )
        if let secret = trimmed(clientSecret) {
            settings.clientSecret = secret
        } else if secretRemoved {
            settings.clientSecret = ""
        }
        if !editing && settings.isEmpty { return nil }
        return settings
    }

    static func isHttpURL(_ value: String) -> Bool {
        let lower = value.lowercased()
        return lower.hasPrefix("http://") || lower.hasPrefix("https://")
    }

    private func trimmed(_ value: String) -> String? {
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? nil : result
    }
}
