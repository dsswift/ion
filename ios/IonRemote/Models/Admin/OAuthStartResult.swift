import Foundation

/// What `oauth.start` answers. For Google off the host it answers at once
/// with the page to open and the flow the landing address completes.
struct OAuthStartResult: Decodable, Equatable, Sendable {
    let ok: Bool
    let error: String?
    let authorizationUrl: String?
    let flowId: String?
}
