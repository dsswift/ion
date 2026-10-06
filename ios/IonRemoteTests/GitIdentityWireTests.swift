import XCTest
@testable import IonRemote

/// `GitIdentitySummary` decode, the shape `gitIdentity.list` answers with.
/// Pins that each wire source/kind string maps to the right enum case and
/// that the optional fields stay optional.
final class GitIdentityWireTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testDecodesEverySourceAndKind() throws {
        let json = """
        [
            { "host": "github.com", "source": "user", "kind": "ssh", "publicKey": "ssh-ed25519 AAAA" },
            { "host": "gitlab.example.com", "source": "exchange-gitlab", "kind": "https-token", "username": "oauth2" },
            { "host": "dev.azure.com", "source": "admin", "kind": "ssh", "publicKey": "ssh-ed25519 BBBB" }
        ]
        """.data(using: .utf8)!

        let identities = try decoder.decode([GitIdentitySummary].self, from: json)
        XCTAssertEqual(identities.count, 3)

        XCTAssertEqual(identities[0].host, "github.com")
        XCTAssertEqual(identities[0].source, .user)
        XCTAssertEqual(identities[0].kind, .ssh)
        XCTAssertEqual(identities[0].publicKey, "ssh-ed25519 AAAA")
        XCTAssertNil(identities[0].username)

        XCTAssertEqual(identities[1].source, .exchangeGitlab)
        XCTAssertEqual(identities[1].kind, .httpsToken)
        XCTAssertEqual(identities[1].username, "oauth2")
        XCTAssertNil(identities[1].publicKey)

        XCTAssertEqual(identities[2].source, .admin)
    }

    func testIdentifiableIdTellsRowsOfOneHostApart() {
        let stored = GitIdentitySummary(host: "github.com", source: .user, kind: .ssh, publicKey: "k")
        let signedIn = GitIdentitySummary(host: "github.com", source: .host, kind: .httpsToken, tool: .gh)
        XCTAssertEqual(stored.id, "user|github.com|")
        XCTAssertEqual(signedIn.id, "host|github.com|gh")
    }
}
