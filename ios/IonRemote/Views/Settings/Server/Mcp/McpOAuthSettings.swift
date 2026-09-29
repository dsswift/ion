import Foundation

/// The OAuth client an add or edit sends (`oauth` on `mcp.add` and
/// `mcp.update`). A nil field is left out and comes from discovery. On an edit,
/// an absent `clientSecret` keeps the stored secret and an empty one removes it.
struct McpOAuthSettings: Equatable, Sendable {
    var clientId: String?
    var clientSecret: String?
    var authUrl: String?
    var tokenUrl: String?
    var scope: String?
    var resource: String?

    var isEmpty: Bool { self == McpOAuthSettings() }

    var jsonValue: JSONValue {
        let pairs: [(String, String?)] = [
            ("clientId", clientId), ("clientSecret", clientSecret), ("authUrl", authUrl),
            ("tokenUrl", tokenUrl), ("scope", scope), ("resource", resource),
        ]
        var fields: [String: JSONValue] = [:]
        for (key, value) in pairs { if let value { fields[key] = .string(value) } }
        return .object(fields)
    }
}
