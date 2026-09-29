import Foundation

/// A GitHub device sign-in in progress, as `oauth.deviceCode` answers: the
/// code the person enters at the verification page, and what the server
/// polls with.
struct GitHubDeviceCode: Decodable, Equatable, Sendable {
    let userCode: String
    let verificationUri: String
    let deviceCode: String
    let interval: Double
    let expiresIn: Double
}
