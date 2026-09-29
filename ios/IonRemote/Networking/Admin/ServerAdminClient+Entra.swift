import Foundation

/// The enterprise sign-in section's calls: the organization account the
/// server's engine is signed in with.
extension ServerAdminClient {

    /// The signed-in account, or nil when none is.
    func entraIdentity() async throws -> EntraIdentity? {
        let value = try await callValue(.entraIdentity)
        return try member("identity", of: value, from: .entraIdentity, as: EntraIdentity?.self)
    }

    /// Begins a device-code sign-in: the engine answers at once with a code to
    /// enter at the provider's page, and waits for it on its own.
    func beginEntraDeviceSignIn() async throws -> EntraDeviceSignIn {
        let value = try await callOkEnvelope(.entraSignIn, args: [.object(["flow": .string("device")])])
        return try decodeAnswer(value, from: .entraSignIn)
    }

    func entraSignOut() async throws {
        _ = try await callOkEnvelope(.entraSignOut)
    }
}
