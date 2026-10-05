import Foundation

/// Where a navigation `ion://` link leads, resolved and validated by the
/// server. Mirrors `DeepLinkNavigateTarget` in
/// `packages/shared/src/types-ipc-deeplink.ts`.
enum DeepLinkNavigateTarget: Decodable, Equatable, Sendable {
    /// A conversation, open in `tabId` (the server opened it if it was not).
    case conversation(conversationId: String, tabId: String)
    /// A settings page or section. `pageId` is the page holding `panel`;
    /// `projectable` says whether the page has settings a phone can show.
    case settings(panel: String, pageId: String, projectable: Bool)
    /// A file inside `dir`; `path` is absolute.
    case file(dir: String, path: String)

    private enum CodingKeys: String, CodingKey {
        case route, conversationId, tabId, panel, pageId, projectable, dir, path
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let route = try container.decode(String.self, forKey: .route)
        switch route {
        case "conversation":
            self = .conversation(
                conversationId: try container.decode(String.self, forKey: .conversationId),
                tabId: try container.decode(String.self, forKey: .tabId)
            )
        case "settings":
            self = .settings(
                panel: try container.decode(String.self, forKey: .panel),
                pageId: try container.decode(String.self, forKey: .pageId),
                projectable: try container.decode(Bool.self, forKey: .projectable)
            )
        case "file":
            self = .file(
                dir: try container.decode(String.self, forKey: .dir),
                path: try container.decode(String.self, forKey: .path)
            )
        default:
            throw DecodingError.dataCorruptedError(forKey: .route, in: container, debugDescription: "unknown deep link route \(route)")
        }
    }
}
