import Foundation

/// A live connection that runs `studio_action`s, as a protocol so a test can
/// stand in for `StudioTransport`.
protocol StudioActionCalling: AnyObject, Sendable {
    /// The scopes the last welcome granted. Nil until the first welcome.
    var grantedScopes: [String]? { get }
    /// Runs one action and returns its value. Throws `StudioActionFailure`.
    func call(_ action: String, args: [JSONValue], timeoutSeconds: Double?) async throws -> JSONValue
}

extension StudioTransport: StudioActionCalling {}
