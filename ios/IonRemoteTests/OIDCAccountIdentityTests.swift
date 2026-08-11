import XCTest
@testable import IonRemote

/// `id_token` payload parsing for the per-pairing account label.
///
/// These build unsigned JWTs by hand: the parser deliberately does not verify
/// signatures (the token arrives over TLS straight from the token endpoint and
/// is used for display only), so a hand-assembled payload is a faithful input.
final class OIDCAccountIdentityTests: XCTestCase {

    // MARK: - Helpers

    private func base64URL(_ json: [String: Any]) -> String {
        // swiftlint:disable:next force_try
        let data = try! JSONSerialization.data(withJSONObject: json)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func makeToken(_ claims: [String: Any]) -> String {
        "\(base64URL(["alg": "none"])).\(base64URL(claims)).signature-not-verified"
    }

    // MARK: - Claim extraction

    func testParsesEntraClaims() {
        let token = makeToken([
            "preferred_username": "user@example.com",
            "name": "Example User",
            "oid": "0000-object-id",
            "tid": "1111-tenant-id",
        ])

        let identity = OIDCAccountIdentity.parse(idToken: token)

        XCTAssertEqual(identity?.username, "user@example.com")
        XCTAssertEqual(identity?.displayName, "Example User")
        XCTAssertEqual(identity?.subject, "0000-object-id")
        XCTAssertEqual(identity?.tenantId, "1111-tenant-id")
    }

    /// `upn` and `email` are accepted fallbacks — not every account type emits
    /// `preferred_username`.
    func testFallsBackToUpnThenEmail() {
        let upnToken = makeToken(["upn": "upn@example.com", "oid": "o"])
        XCTAssertEqual(OIDCAccountIdentity.parse(idToken: upnToken)?.username, "upn@example.com")

        let emailToken = makeToken(["email": "email@example.com", "oid": "o"])
        XCTAssertEqual(OIDCAccountIdentity.parse(idToken: emailToken)?.username, "email@example.com")
    }

    func testPrefersPreferredUsernameOverUpn() {
        let token = makeToken([
            "preferred_username": "preferred@example.com",
            "upn": "upn@example.com",
            "oid": "o",
        ])
        XCTAssertEqual(OIDCAccountIdentity.parse(idToken: token)?.username, "preferred@example.com")
    }

    func testFallsBackToSubWhenNoOid() {
        let token = makeToken(["sub": "subject-value", "preferred_username": "user@example.com"])
        XCTAssertEqual(OIDCAccountIdentity.parse(idToken: token)?.subject, "subject-value")
    }

    func testEmptyClaimIsSkipped() {
        let token = makeToken(["preferred_username": "", "name": "Fallback Name", "oid": "o"])
        let identity = OIDCAccountIdentity.parse(idToken: token)
        XCTAssertEqual(identity?.username, "")
        XCTAssertEqual(identity?.label, "Fallback Name", "label falls through an empty username")
    }

    // MARK: - Malformed input returns nil rather than crashing

    func testTooFewSegmentsReturnsNil() {
        XCTAssertNil(OIDCAccountIdentity.parse(idToken: "only.two"))
    }

    func testEmptyStringReturnsNil() {
        XCTAssertNil(OIDCAccountIdentity.parse(idToken: ""))
    }

    func testNonBase64PayloadReturnsNil() {
        XCTAssertNil(OIDCAccountIdentity.parse(idToken: "header.!!!not-base64!!!.sig"))
    }

    func testNonJSONPayloadReturnsNil() {
        let payload = Data("not json at all".utf8).base64EncodedString()
            .replacingOccurrences(of: "=", with: "")
        XCTAssertNil(OIDCAccountIdentity.parse(idToken: "header.\(payload).sig"))
    }

    func testPayloadWithNoRecognizedClaimsReturnsNil() {
        let token = makeToken(["aud": "some-audience", "iss": "https://issuer.example.com"])
        XCTAssertNil(OIDCAccountIdentity.parse(idToken: token),
            "a payload with no identity claims is not a usable account")
    }

    /// Base64url segments drop their padding; the decoder must restore it.
    func testUnpaddedPayloadDecodes() {
        // Claim sizes here are chosen so the encoded payload needs padding.
        let token = makeToken(["oid": "abc"])
        XCTAssertNotNil(OIDCAccountIdentity.parse(idToken: token))
    }

    // MARK: - Label preference

    func testLabelPrefersUsernameThenNameThenSubject() {
        let full = OIDCAccountIdentity(username: "u@example.com", displayName: "Name", subject: "s", tenantId: "t", issuedAt: Date())
        XCTAssertEqual(full.label, "u@example.com")

        let noUser = OIDCAccountIdentity(username: "", displayName: "Name", subject: "s", tenantId: "t", issuedAt: Date())
        XCTAssertEqual(noUser.label, "Name")

        let subjectOnly = OIDCAccountIdentity(username: "", displayName: "", subject: "s", tenantId: "t", issuedAt: Date())
        XCTAssertEqual(subjectOnly.label, "s")

        let empty = OIDCAccountIdentity(username: "", displayName: "", subject: "", tenantId: "", issuedAt: Date())
        XCTAssertEqual(empty.label, "Unknown account")
    }
}
