import XCTest
@testable import IonRemote

/// Git access results decode from the server's shapes, and each call sends
/// the action and arguments its handler reads.
final class GitAccessDecodingAndCallTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }
    private func json(_ text: String) -> JSONValue { ProjectsFixtures.json(text) }

    func testResultsDecode() throws {
        let identities = try json(GitAccessFixtures.identities).decoded(as: [GitIdentitySummary].self)
        XCTAssertEqual(identities.map(\.host), ["github.com", "gitlab.example.org"])
        XCTAssertEqual(identities.map(\.kind), [.ssh, .httpsToken])
        XCTAssertEqual(identities[1].source, .admin)
        XCTAssertFalse(GitIdentityLabels.isRemovable(identities[1]))
        XCTAssertTrue(GitIdentityLabels.isRemovable(identities[0]))

        let hostRows = try json(GitAccessFixtures.hostIdentities).decoded(as: [GitIdentitySummary].self)
        XCTAssertEqual(hostRows.map(\.source), [.host, .host, .host])
        XCTAssertEqual(hostRows.map(\.file), ["id_ed25519.pub", "id_rsa.pub", nil])
        XCTAssertEqual(hostRows[2].tool, .gh)
        XCTAssertEqual(Set(hostRows.map(\.id)).count, 3, "two keys under one host are still two rows")
        XCTAssertEqual(hostRows[0].hostLabel, "Every host")
        XCTAssertEqual(GitIdentityLabels.source(hostRows[0], serverLabel: "Studio Mac"), "id_ed25519.pub in ~/.ssh on Studio Mac")
        XCTAssertEqual(GitIdentityLabels.source(hostRows[2], serverLabel: "Studio Mac"), "Signed in with gh as example-user")
        XCTAssertFalse(GitIdentityLabels.isRemovable(hostRows[0]))
        XCTAssertTrue(try json(GitAccessFixtures.author).decoded(as: EnvironmentGitAuthor.self).isSet)
        XCTAssertFalse(try json(GitAccessFixtures.emptyAuthor).decoded(as: EnvironmentGitAuthor.self).isSet)
        let passing = try json(GitAccessFixtures.passingTest).decoded(as: EnvironmentGitTest.self)
        XCTAssertEqual(passing.defaultBranch, "main")
        XCTAssertEqual(passing.durationMs, 412)
        XCTAssertEqual(try json(GitAccessFixtures.failingTest).decoded(as: EnvironmentGitTest.self).error, "Permission denied (publickey)")
        XCTAssertEqual(try json(GitAccessFixtures.authorize).decoded(as: GitAuthorizeStarted.self).started, true)
    }

    func testCredentialCallsSendHostAndSecretsUnderTheHandlersKeys() async throws {
        caller.answer(.gitIdentityMintSshKey, with: .success(json(GitAccessFixtures.publicKey)))
        caller.answer(.gitIdentitySetSshKey, with: .success(json(GitAccessFixtures.publicKey)))
        _ = try await client.mintSshKey(host: "github.com")
        _ = try await client.setSshKey(host: "github.com", privateKey: "KEY")
        try await client.setGitToken(host: "gitlab.example.org", token: "T")
        try await client.setGitToken(host: "gitlab.example.org", token: "T", username: "bot")
        try await client.removeGitIdentity(host: "github.com")
        XCTAssertEqual(caller.calls, [
            .init(action: "gitIdentity.mintSshKey", args: [.object(["host": .string("github.com")])]),
            .init(action: "gitIdentity.setSshKey", args: [.object(["host": .string("github.com"), "privateKey": .string("KEY")])]),
            .init(action: "gitIdentity.setToken", args: [.object(["host": .string("gitlab.example.org"), "token": .string("T")])]),
            .init(action: "gitIdentity.setToken", args: [.object(["host": .string("gitlab.example.org"), "token": .string("T"), "username": .string("bot")])]),
            .init(action: "gitIdentity.remove", args: [.object(["host": .string("github.com")])]),
        ])
    }

    func testAccessAndAuthorCalls() async throws {
        caller.answer(.environmentGitTest, with: .success(json(GitAccessFixtures.passingTest)))
        caller.answer(.environmentGitAuthorSet, with: .success(json(GitAccessFixtures.author)))
        caller.answer(.gitIdentityAuthorize, with: .success(json(GitAccessFixtures.authorize)))
        _ = try await client.testGitAccess(url: "git@github.com:example/app.git")
        _ = try await client.setGitAuthor(EnvironmentGitAuthor(name: "A User", email: "user@example.com"))
        _ = try await client.authorizeGitIdentity(host: "github.com")
        XCTAssertEqual(caller.calls, [
            .init(action: "environment.git.test", args: [.object(["url": .string("git@github.com:example/app.git")])]),
            .init(action: "environment.git.author.set", args: [.object(["name": .string("A User"), "email": .string("user@example.com")])]),
            .init(action: "gitIdentity.authorize", args: [.object(["host": .string("github.com")])]),
        ])
    }
}
