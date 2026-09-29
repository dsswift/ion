import XCTest
import CryptoKit
@testable import IonRemote

/// `POST /auth/pair` against a server the test plays: it holds its own X25519
/// key, registers the client id the way the real server does, and answers.
final class StudioPairingTests: XCTestCase {

    private let request = StudioPairing.Request(
        serverURL: URL(string: "ws://192.168.1.20:7331/studio")!,
        code: "one-time-code",
        label: "Test phone",
        deviceId: "device-1"
    )

    /// Plays the server side and records what the client sent.
    private final class FakeServer: @unchecked Sendable {
        let privateKey = Curve25519.KeyAgreement.PrivateKey()
        private let lock = NSLock()
        private var requests: [URLRequest] = []
        var pairStatus = 200
        var pairBodyOverride: Data?
        var registeredClientIdOverride: String?
        var configBody = #"{"environmentId":"env-42","label":"Studio host","nonce":"bm9uY2U=","sealedTcp":true}"#

        var seen: [URLRequest] { lock.withLock { requests } }

        var transport: StudioPairing.Transport {
            { [self] request in
                lock.withLock { requests.append(request) }
                if request.url?.path == "/auth/config" { return (200, Data(configBody.utf8)) }
                if let pairBodyOverride { return (pairStatus, pairBodyOverride) }
                let sent = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
                let peerBytes = Data(base64Encoded: sent?["peerPublicKey"] as? String ?? "") ?? Data()
                let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerBytes)
                let secret = try E2ECrypto.deriveSharedSecret(privateKey: privateKey, peerPublicKey: peer)
                let clientId = registeredClientIdOverride ?? String(E2ECrypto.deriveChannelId(sharedSecret: secret).prefix(16))
                let body: [String: Any] = [
                    "clientId": clientId,
                    "ourPublicKey": privateKey.publicKey.rawRepresentation.base64EncodedString(),
                    "scopes": ["conversations:read", "conversations:operate"],
                    "relays": [["url": "wss://relay.example.org", "auth": ["mode": "psk", "key": "psk-1"]]]
                ]
                return (pairStatus, try JSONSerialization.data(withJSONObject: body))
            }
        }
    }

    func testPairingDerivesTheSameSecretAsTheServerAndReturnsWhatMustBeStored() async throws {
        let server = FakeServer()
        let phoneKey = Curve25519.KeyAgreement.PrivateKey()
        let record = try await StudioPairing.pair(request, privateKey: phoneKey, transport: server.transport)

        let serverSecret = try E2ECrypto.deriveSharedSecret(privateKey: server.privateKey, peerPublicKey: phoneKey.publicKey)
        XCTAssertEqual(record.secret, serverSecret.withUnsafeBytes { Data($0) })
        XCTAssertEqual(record.secret.count, 32)
        XCTAssertEqual(record.clientId, String(E2ECrypto.deriveChannelId(sharedSecret: serverSecret).prefix(16)))
        XCTAssertEqual(record.environmentId, "env-42")
        XCTAssertEqual(record.label, "Studio host")
        XCTAssertEqual(record.url, "ws://192.168.1.20:7331/studio")
        XCTAssertEqual(record.scopes, ["conversations:read", "conversations:operate"])
        XCTAssertEqual(record.relays, [StudioEnvironmentRelay(url: "wss://relay.example.org", auth: .psk(key: "psk-1"))])

        // A frame the phone seals with the record opens with the server's secret.
        let sealed = try SealedEnvelope.seal(text: "hello", key: record.key)
        XCTAssertEqual(SealedEnvelope.open(sealed, key: serverSecret)?.bytes, Data("hello".utf8))
    }

    func testThePairRequestNamesAMobileDevice() async throws {
        let server = FakeServer()
        _ = try await StudioPairing.pair(request, transport: server.transport)
        XCTAssertEqual(server.seen.first?.url?.absoluteString, "http://192.168.1.20:7331/auth/config")
        let post = try XCTUnwrap(server.seen.last)
        XCTAssertEqual(post.url?.absoluteString, "http://192.168.1.20:7331/auth/pair")
        XCTAssertNil(post.value(forHTTPHeaderField: "Authorization"), "a server with no sign-in gets no token")
        XCTAssertEqual(post.httpMethod, "POST")
        XCTAssertEqual(post.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(post.httpBody)) as? [String: String])
        XCTAssertEqual(body["kind"], "mobile")
        XCTAssertEqual(body["code"], "one-time-code")
        XCTAssertEqual(body["label"], "Test phone")
        XCTAssertEqual(body["deviceId"], "device-1")
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(body["peerPublicKey"]))?.count, 32)
    }

    func testAServerThatOffersSignInGetsThePersonsTokenWithThePairing() async throws {
        let server = FakeServer()
        server.configBody = Self.signedInConfig
        let asked = SignInRecorder()
        _ = try await StudioPairing.pair(request, transport: server.transport) { signIn in
            await asked.record(signIn)
            return "person-token"
        }
        let signIns = await asked.seen
        XCTAssertEqual(signIns, [StudioServerSignIn(issuer: "https://login.example.org/tenant/v2.0", audience: "server-app", scope: "Studio.Access", clientId: "sign-in-app")])
        XCTAssertEqual(signIns.first?.tokenScope, "api://server-app/Studio.Access")
        XCTAssertEqual(signIns.first?.signInClientId, "sign-in-app")
        let post = try XCTUnwrap(server.seen.last)
        XCTAssertEqual(post.url?.path, "/auth/pair")
        XCTAssertEqual(post.value(forHTTPHeaderField: "Authorization"), "Bearer person-token")
    }

    func testAFailedSignInStopsBeforeTheCodeIsSpent() async {
        let server = FakeServer()
        server.configBody = Self.signedInConfig
        do {
            _ = try await StudioPairing.pair(request, transport: server.transport) { _ in throw URLError(.userCancelledAuthentication) }
            XCTFail("paired without a sign-in")
        } catch {
            guard case .signInFailed = error as? StudioPairing.Failure else { return XCTFail("wrong failure: \(error)") }
        }
        XCTAssertFalse(server.seen.contains { $0.url?.path == "/auth/pair" }, "the one-time code was sent without a sign-in")
    }

    func testARejectedSignInIsReportedInPlainWords() async {
        let server = FakeServer()
        server.configBody = Self.signedInConfig
        server.pairStatus = 401
        server.pairBodyOverride = Data(#"{"error":"invalid_bearer"}"#.utf8)
        do {
            _ = try await StudioPairing.pair(request, transport: server.transport) { _ in "wrong-account-token" }
            XCTFail("pairing succeeded")
        } catch {
            XCTAssertEqual(error as? StudioPairing.Failure, .refused(reason: "invalid_bearer"))
            XCTAssertTrue(error.localizedDescription.contains("did not accept your sign-in"))
        }
    }

    func testTheScopeRuleQualifiesOnlyShortNames() {
        XCTAssertEqual(OIDCScope.compose(audience: "app", requiredScope: "Studio.Access"), "api://app/Studio.Access")
        XCTAssertEqual(OIDCScope.compose(audience: "api://app", requiredScope: "Studio.Access"), "api://app/Studio.Access")
        XCTAssertEqual(OIDCScope.compose(audience: "app", requiredScope: "api://other/Custom"), "api://other/Custom")
    }

    private static let signedInConfig = #"{"environmentId":"env-42","label":"Studio host","nonce":"bm9uY2U=","sealedTcp":true,"oidc":{"issuer":"https://login.example.org/tenant/v2.0","audience":"server-app","scope":"Studio.Access","clientId":"sign-in-app"}}"#

    private actor SignInRecorder {
        private(set) var seen: [StudioServerSignIn] = []
        func record(_ signIn: StudioServerSignIn) { seen.append(signIn) }
    }

    func testARefusalCarriesTheServersReason() async {
        let server = FakeServer()
        server.pairStatus = 410
        server.pairBodyOverride = Data(#"{"error":"expired"}"#.utf8)
        await assertPairing(server, failsWith: .refused(reason: "expired"))

        server.pairBodyOverride = Data("gone".utf8)
        await assertPairing(server, failsWith: .refused(reason: "HTTP 410"))
    }

    func testAMalformedAnswerAndAMismatchedClientIdFail() async {
        let malformed = FakeServer()
        malformed.pairBodyOverride = Data(#"{"clientId":"abc","ourPublicKey":"not base64"}"#.utf8)
        await assertPairing(malformed, failsWith: .malformedResponse)

        let mismatched = FakeServer()
        mismatched.registeredClientIdOverride = "0000000000000000"
        await assertPairing(mismatched, failsWith: .secretMismatch)
    }

    func testAnUnreachableServerAndAMissingEnvironmentIdFail() async {
        do {
            _ = try await StudioPairing.pair(request) { _ in throw URLError(.cannotConnectToHost) }
            XCTFail("paired with nothing listening")
        } catch {
            guard case .unreachable = error as? StudioPairing.Failure else { return XCTFail("wrong failure: \(error)") }
        }

        let server = FakeServer()
        server.configBody = #"{"nonce":"bm9uY2U="}"#
        await assertPairing(server, failsWith: .identityUnavailable("the server reported no environment id"))
    }

    private func assertPairing(_ server: FakeServer, failsWith expected: StudioPairing.Failure, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await StudioPairing.pair(request, transport: server.transport)
            XCTFail("pairing succeeded", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? StudioPairing.Failure, expected, file: file, line: line)
        }
    }
}
