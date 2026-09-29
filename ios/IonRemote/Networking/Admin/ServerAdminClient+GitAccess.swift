import Foundation

/// The Git access page's calls: this person's git credentials on the server,
/// the host's own ssh keys, access tests, and the commit author.
extension ServerAdminClient {

    func listGitIdentities() async throws -> [GitIdentitySummary] {
        try await call(.gitIdentityList)
    }

    /// Makes a new key pair on the server for `host` and returns its public half.
    func mintSshKey(host: String) async throws -> GitPublicKey {
        try await call(.gitIdentityMintSshKey, fields: ["host": .string(host)])
    }

    func setSshKey(host: String, privateKey: String) async throws -> GitPublicKey {
        try await call(.gitIdentitySetSshKey, fields: ["host": .string(host), "privateKey": .string(privateKey)])
    }

    func setGitToken(host: String, token: String, username: String? = nil) async throws {
        var fields: [String: JSONValue] = ["host": .string(host), "token": .string(token)]
        if let username, !username.isEmpty { fields["username"] = .string(username) }
        try await callVoid(.gitIdentitySetToken, fields: fields)
    }

    func removeGitIdentity(host: String) async throws {
        try await callVoid(.gitIdentityRemove, fields: ["host": .string(host)])
    }

    /// Starts the git host's sign-in through the server's OAuth exchange.
    func authorizeGitIdentity(host: String) async throws -> GitAuthorizeStarted {
        try await call(.gitIdentityAuthorize, fields: ["host": .string(host)])
    }

    func hostSshKeys() async throws -> [HostSshKey] {
        try await call(.environmentGitHostKeys)
    }

    /// Runs `git ls-remote` for `url` on the server with its stored credentials.
    func testGitAccess(url: String) async throws -> EnvironmentGitTest {
        // ls-remote against a slow host can outlast the default action timeout.
        try await call(.environmentGitTest, fields: ["url": .string(url)], timeoutSeconds: 90)
    }

    func gitAuthor() async throws -> EnvironmentGitAuthor {
        try await call(.environmentGitAuthorGet)
    }

    func setGitAuthor(_ author: EnvironmentGitAuthor) async throws -> EnvironmentGitAuthor {
        try await call(.environmentGitAuthorSet, fields: ["name": .string(author.name), "email": .string(author.email)])
    }
}
