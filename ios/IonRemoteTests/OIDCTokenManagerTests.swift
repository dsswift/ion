import XCTest
@testable import IonRemote

final class OIDCTokenManagerTests: XCTestCase {

    private let testDeviceId = "test-device-oidc-phase2"
    private var keychainKey: String { "com.ion.oidc.refresh.\(testDeviceId)" }

    override func tearDown() {
        super.tearDown()
        KeychainHelper.delete(keychainKey)
    }

    // MARK: - Keychain round-trip (proves the key format OIDCTokenManager uses)

    func testKeychainComposedKey() {
        let key = "com.ion.oidc.refresh.test-device"
        KeychainHelper.set("refresh-value", service: key)
        XCTAssertEqual(KeychainHelper.get(key), "refresh-value")
        KeychainHelper.delete(key)
        XCTAssertNil(KeychainHelper.get(key))
    }

    // MARK: - Malformed issuer hardening

    // discoverEndpoints composes the discovery URL from the wire-derived issuer
    // and now guards `URL(string:)` instead of force-unwrapping it. This pins
    // the guard predicate: a control-character issuer yields a nil URL, which is
    // the exact condition discoverEndpoints throws .discoveryFailed on rather
    // than crashing. A well-formed issuer still composes a valid URL.
    func testMalformedIssuerProducesNilDiscoveryURL() {
        let malformed = "ht tp://bad host\u{0}/issuer"
        let composed = URL(string: malformed.trimmingCharacters(in: .init(charactersIn: "/")) + "/.well-known/openid-configuration")
        XCTAssertNil(composed, "a malformed issuer must not compose a URL; the guard throws instead of crashing")
    }

    func testWellFormedIssuerComposesDiscoveryURL() {
        let good = "https://login.example.com/tenant/"
        let composed = URL(string: good.trimmingCharacters(in: .init(charactersIn: "/")) + "/.well-known/openid-configuration")
        XCTAssertNotNil(composed)
        XCTAssertEqual(composed?.absoluteString, "https://login.example.com/tenant/.well-known/openid-configuration")
    }

    // Note: OIDCTokenManager tests that require network calls (silent refresh,
    // interactive sign-in) are exercised via end-to-end smoke test only —
    // ASWebAuthenticationSession requires a live UI presentation context
    // unavailable in XCTest. The cache and invalidation tests below use
    // internal state seeding via a test-seeding initializer.

    // MARK: - Refresh-key composition

    // One definition backs the write path (parseTokenResponse), the read path
    // (silent refresh), and the registry's delete path. This pins the format so
    // a rename cannot silently orphan tokens already in the Keychain.
    func testRefreshKeyComposition() {
        XCTAssertEqual(
            OIDCTokenManager.refreshKey(deviceId: "abc123"),
            "com.ion.oidc.refresh.abc123"
        )
    }

    func testRefreshKeyIsPerDevice() {
        XCTAssertNotEqual(
            OIDCTokenManager.refreshKey(deviceId: "personal"),
            OIDCTokenManager.refreshKey(deviceId: "work")
        )
    }

    func testCodeVerifierRejectsRandomSourceFailure() {
        XCTAssertThrowsError(try OIDCTokenManager.makeCodeVerifier { _ in throw OIDCTokenError.randomGenerationFailed }) { error in
            guard case OIDCTokenError.randomGenerationFailed = error else {
                return XCTFail("expected randomGenerationFailed, got \(error)")
            }
        }
    }

    func testCallbackStateRejectsMismatch() {
        XCTAssertThrowsError(try OIDCTokenManager.validateCallbackState("other-request", expected: "current-request")) { error in
            guard case OIDCTokenError.callbackStateMismatch = error else {
                return XCTFail("expected callbackStateMismatch, got \(error)")
            }
        }
    }

    func testCallbackStateAcceptsExactMatch() throws {
        XCTAssertNoThrow(try OIDCTokenManager.validateCallbackState("current-request", expected: "current-request"))
    }

    // MARK: - Cache tier (seeded)

    private func makeSeeded(expiresIn: TimeInterval, token: String = "seeded-access-token") -> OIDCTokenManager {
        OIDCTokenManager(
            clientId: "test-client",
            issuer: "https://login.example.com/tenant/v2.0",
            scope: "api://test/Relay.Access",
            deviceId: testDeviceId,
            seedToken: token,
            seedExpiry: Date().addingTimeInterval(expiresIn)
        )
    }

    /// A comfortably-unexpired seeded token is served from cache. No network
    /// call happens, which is what makes this assertable at all: tier 2 would
    /// hit the token endpoint and tier 3 needs a UI presentation context.
    func testSeededTokenServedFromCache() async throws {
        let manager = makeSeeded(expiresIn: 3600)
        let token = try await manager.accessToken()
        XCTAssertEqual(token, "seeded-access-token")
    }

    func testSeededTokenAlsoServesSilentAccessor() async {
        let manager = makeSeeded(expiresIn: 3600)
        let token = await manager.accessTokenIfAvailable()
        XCTAssertEqual(token, "seeded-access-token")
    }

    /// A token inside the 120-second expiry lead is treated as already expired,
    /// so it is not handed to a connection that would outlive it.
    func testTokenInsideExpiryLeadIsNotServed() async {
        let manager = makeSeeded(expiresIn: 60)
        // No refresh token in the Keychain, so the silent path can only report
        // "nothing available" rather than returning the near-expiry token.
        KeychainHelper.delete(keychainKey)
        let token = await manager.accessTokenIfAvailable()
        XCTAssertNil(token, "a token within the 2-minute lead window must not be reused")
    }

    // MARK: - Invalidation

    func testInvalidateClearsCachedToken() async {
        let manager = makeSeeded(expiresIn: 3600)
        let before = await manager.accessTokenIfAvailable()
        XCTAssertEqual(before, "seeded-access-token")

        await manager.invalidateAccessToken()

        // With the cache cleared and no refresh token stored, the silent path
        // has nothing left to return.
        KeychainHelper.delete(keychainKey)
        let after = await manager.accessTokenIfAvailable()
        XCTAssertNil(after, "invalidateAccessToken must drop the cached token")
    }

    // MARK: - Identity

    func testSeededManagerHasNoIdentityUntilTokenParsed() async {
        let manager = makeSeeded(expiresIn: 3600)
        let identity = await manager.currentIdentity()
        XCTAssertNil(identity, "identity is captured from an id_token, not from a seeded access token")
    }
}
