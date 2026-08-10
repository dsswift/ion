import XCTest
@testable import IonRemote

/// Classification of relay refusals into recoverable vs. terminal.
///
/// 403 was previously lumped in with 401 and 4401 as "invalidate and retry".
/// The relay returns 403 for exactly one reason — the channel is bound to a
/// different OIDC subject (`relay/main.go`, "forbidden: channel owned by
/// another identity") — and refreshing produces a token for the same subject.
/// Retrying it is an infinite backoff ladder that can never succeed, which is
/// what a phone hits when it is pointed at a desktop whose relay channel
/// belongs to the user's other tenant.
final class RelayRejectionKindTests: XCTestCase {

    // MARK: - Expired credential (recoverable)

    func testCloseCode4401IsExpiredCredential() {
        XCTAssertEqual(
            RelayRejection.classify(closeCode: 4401, httpStatus: nil),
            .expiredCredential
        )
    }

    func testHttp401IsExpiredCredential() {
        XCTAssertEqual(
            RelayRejection.classify(closeCode: nil, httpStatus: 401),
            .expiredCredential
        )
    }

    // MARK: - Identity mismatch (terminal)

    func testHttp403IsIdentityMismatch() {
        XCTAssertEqual(
            RelayRejection.classify(closeCode: nil, httpStatus: 403),
            .identityMismatch,
            "403 means the channel belongs to another subject; a refresh cannot fix it"
        )
    }

    /// A live socket closed with 4401 is an expiry even if some stale status is
    /// also readable — the close code is the more specific signal.
    func testCloseCodeTakesPrecedenceOverStatus() {
        XCTAssertEqual(
            RelayRejection.classify(closeCode: 4401, httpStatus: 403),
            .expiredCredential
        )
    }

    // MARK: - Not a refusal

    func testAbnormalCloseIsNotARefusal() {
        XCTAssertEqual(RelayRejection.classify(closeCode: 1006, httpStatus: nil), .none)
    }

    func testNoSignalsIsNotARefusal() {
        XCTAssertEqual(RelayRejection.classify(closeCode: nil, httpStatus: nil), .none)
    }

    func testSuccessfulUpgradeStatusIsNotARefusal() {
        XCTAssertEqual(RelayRejection.classify(closeCode: 1008, httpStatus: 101), .none)
        XCTAssertEqual(RelayRejection.classify(closeCode: 1001, httpStatus: 101), .none)
    }

    func testServerErrorIsNotACredentialRefusal() {
        XCTAssertEqual(RelayRejection.classify(closeCode: nil, httpStatus: 500), .none)
    }

    // MARK: - Wrapper stays compatible

    // isCredentialRejection is still used by RelayClientTests and must keep
    // reporting true for every refusal kind.
    func testWrapperReportsBothRefusalKinds() {
        XCTAssertTrue(RelayRejection.isCredentialRejection(closeCode: 4401, httpStatus: nil))
        XCTAssertTrue(RelayRejection.isCredentialRejection(closeCode: nil, httpStatus: 401))
        XCTAssertTrue(RelayRejection.isCredentialRejection(closeCode: nil, httpStatus: 403))
        XCTAssertFalse(RelayRejection.isCredentialRejection(closeCode: 1006, httpStatus: nil))
        XCTAssertFalse(RelayRejection.isCredentialRejection(closeCode: nil, httpStatus: nil))
    }
}
