import Foundation

/// Provider credentials and sign-ins on the server. Every value here is
/// bearer-grade: it is sent, never logged.
extension ServerAdminClient {

    /// Saves an API key; an empty key removes the saved one.
    func storeCredential(provider: String, credential: String) async throws {
        try await callChecked(.providerStoreCredential, args: [.object([
            "provider": .string(provider), "credential": .string(credential)
        ])])
    }

    /// Starts a delegated-CLI sign-in. Its stages arrive on `ion:provider-login-event`.
    func providerLogin(provider: String) async throws {
        try await callChecked(.providerLogin, args: [.object(["provider": .string(provider)])])
    }

    func providerLoginCancel(provider: String) async throws {
        try await callChecked(.providerLoginCancel, args: [.object(["provider": .string(provider)])])
    }

    /// Returns the authorization code a sign-in parked on `await_auth_code` waits for.
    func providerLoginCode(provider: String, code: String) async throws {
        try await callChecked(.providerLoginCode, args: [.object(["provider": .string(provider), "code": .string(code)])])
    }

    func providerLogout(provider: String) async throws {
        try await callChecked(.providerLogout, args: [.object(["provider": .string(provider)])])
    }

    /// Starts a browser sign-in. Google answers at once with the page to open
    /// and a flow id; the landing address goes to `completeSignIn`.
    func oauthStart(provider: String) async throws -> OAuthStartResult {
        let result: OAuthStartResult = try await call(.oauthStart, args: [.object(["provider": .string(provider)])])
        guard result.ok else {
            throw StudioActionFailure.failed(code: "declined", message: result.error ?? "\(serverLabel) could not start the sign-in.")
        }
        return result
    }

    func oauthLogout(provider: String) async throws {
        try await callChecked(.oauthLogout, args: [.object(["provider": .string(provider)])])
    }

    /// Finishes a sign-in whose browser half ran on this phone.
    func completeSignIn(flowId: String, callbackUrl: String) async throws {
        try await callChecked(.authCompleteSignIn, args: [.object([
            "flowId": .string(flowId), "callbackUrl": .string(callbackUrl)
        ])])
    }

    /// Starts GitHub Copilot's device sign-in.
    func githubDeviceCode() async throws -> GitHubDeviceCode {
        let value = try await callValue(.oauthDeviceCode, args: [.object(["provider": .string("github-copilot")])])
        let result: ProviderActionResult = try decodeResult(value, action: .oauthDeviceCode)
        guard result.ok else {
            throw StudioActionFailure.failed(code: "declined", message: result.error ?? "\(serverLabel) could not start the GitHub sign-in.")
        }
        return try decodeResult(value, action: .oauthDeviceCode)
    }

    /// Waits while the server polls GitHub, until the person approves the
    /// code or it expires. The server stores the credential itself.
    func githubDevicePoll(_ code: GitHubDeviceCode) async throws {
        try await callChecked(.oauthDevicePoll, args: [.object([
            "deviceCode": .string(code.deviceCode), "interval": .double(code.interval), "expiresIn": .double(code.expiresIn)
        ])], timeoutSeconds: code.expiresIn + 30)
    }

    private func decodeResult<T: Decodable>(_ value: JSONValue, action: PhoneAction) throws -> T {
        do {
            return try value.decoded(as: T.self)
        } catch {
            DiagnosticLog.log("admin client: result did not decode", tag: "admin.client", level: .error, fields: [
                "server": serverLabel, "action": action.rawValue, "type": String(describing: T.self),
                "error": String(String(describing: error).prefix(500))
            ])
            throw StudioActionFailure.failed(code: "bad_result", message: "\(serverLabel) answered \(action.rawValue) with a result this app cannot read.")
        }
    }
}
