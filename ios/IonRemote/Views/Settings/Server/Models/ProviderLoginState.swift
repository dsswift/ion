import Foundation

/// Where a delegated-CLI sign-in on the server stands, as this phone shows it.
enum ProviderLoginState: Equatable, Sendable {
    /// Started; the server's CLI is working. A device code, when the CLI issued one.
    case waiting(userCode: String?, verificationUrl: String?)
    /// The CLI waits for the authorization code the sign-in page shows.
    case awaitingCode(signInUrl: String?)
    case failed(String)
}
