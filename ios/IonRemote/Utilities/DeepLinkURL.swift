import Foundation

/// `ion://` links this phone builds or receives. The server parses and
/// validates every link; the phone only builds the ones it copies and tells
/// an `ion://` link apart from a pairing link. Mirrors the builders in
/// `packages/shared/src/deeplink-url.ts`.
enum DeepLinkURL {
    static let scheme = "ion"

    /// Whether `url` is an `ion://` link for the server to resolve.
    static func isDeepLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
    }

    /// `ion://conversation?id=<conversationId>`.
    static func conversation(_ conversationId: String) -> String {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "conversation"
        components.queryItems = [URLQueryItem(name: "id", value: conversationId)]
        return components.string ?? "\(scheme)://conversation"
    }
}
