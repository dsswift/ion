import Foundation

/// The server's answer to `deeplink.open`. Mirrors `DeepLinkOpenResult` in
/// `packages/shared/src/types-ipc-deeplink.ts`.
enum DeepLinkOpenResult: Decodable, Equatable, Sendable {
    /// A navigation link: move this phone's view to `target`.
    case navigate(DeepLinkNavigateTarget)
    /// An action link: show `request`, then answer with `deeplink.confirmResult`.
    case confirm(id: String, request: DeepLinkConfirmRequest)
    /// The server refused the link.
    case error(reason: String)

    private enum CodingKeys: String, CodingKey {
        case kind, target, id, request, reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "navigate":
            self = .navigate(try container.decode(DeepLinkNavigateTarget.self, forKey: .target))
        case "confirm":
            self = .confirm(
                id: try container.decode(String.self, forKey: .id),
                request: try container.decode(DeepLinkConfirmRequest.self, forKey: .request)
            )
        case "error":
            self = .error(reason: try container.decode(String.self, forKey: .reason))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown deep link result \(kind)")
        }
    }
}
