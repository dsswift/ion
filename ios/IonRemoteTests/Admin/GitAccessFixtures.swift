import Foundation
@testable import IonRemote

/// Results in the shapes the server's git access handlers return
/// (`server/src/environment/git-access.ts`, `protocol/git-identity-actions.ts`).
enum GitAccessFixtures {
    static let identities = """
    [{"host":"github.com","source":"user","kind":"ssh","publicKey":"ssh-ed25519 AAAAC3Nza user@example.com"},
     {"host":"gitlab.example.org","source":"admin","kind":"https-token","username":"oauth2"}]
    """
    static let hostKeys = #"[{"file":"id_ed25519.pub","type":"ssh-ed25519","comment":"user@example.com"}]"#
    static let author = #"{"name":"A User","email":"user@example.com"}"#
    static let emptyAuthor = #"{"name":"","email":""}"#
    static let passingTest = #"{"url":"git@github.com:example/app.git","ok":true,"defaultBranch":"main","durationMs":412}"#
    static let failingTest = #"{"url":"git@github.com:example/app.git","ok":false,"error":"Permission denied (publickey)","durationMs":95}"#
    static let publicKey = #"{"publicKey":"ssh-ed25519 AAAAC3Nza ion"}"#
    static let authorize = #"{"started":true,"authorizationUrl":"https://github.com/login/oauth/authorize?client_id=x&state=y"}"#
}
