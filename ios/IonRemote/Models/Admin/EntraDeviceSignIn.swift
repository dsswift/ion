import Foundation

/// A device-code sign-in the server's engine began (`entra.signIn` with
/// `flow: 'device'`): the code to enter at `verificationUri` before it expires.
struct EntraDeviceSignIn: Codable, Equatable, Sendable {
    let userCode: String
    let verificationUri: String
    /// Seconds until the code stops working.
    let expiresIn: Double
}
