import Foundation

/// `gitIdentity.authorize`: the git host's sign-in page. Its callback lands
/// on the server's own public address, so the phone only opens it.
struct GitAuthorizeStarted: Decodable, Equatable, Sendable {
    let started: Bool
    let authorizationUrl: String
}
