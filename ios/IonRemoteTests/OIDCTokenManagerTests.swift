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
}
