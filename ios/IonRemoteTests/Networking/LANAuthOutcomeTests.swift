import XCTest
@testable import IonRemote

/// Pins the LAN auth-failure classification introduced after the re-pair
/// incident: the desktop's LAN auth cooldown closed a fresh iOS socket
/// instantly (close 1008 / "Socket is not connected"), iOS treated the
/// verdict-less failure as an auth rejection, flipped to `.authFailed`, and
/// the app auto-wiped every paired device.
///
/// The contract these tests pin:
/// - **Definitive rejection** (→ `.rejected`): explicit `auth_result` with
///   `success: false`, or an application close code 4000–4999 (the desktop
///   uses 4003 for "unknown device" / "device removed").
/// - **Transient** (→ `.transient`): no verdict from the desktop — close
///   code 1008 (auth cooldown), socket errors with no close frame (nil),
///   or the stream ending without an `auth_result`.
final class LANAuthOutcomeTests: XCTestCase {

    // MARK: - resolve: stream outcome × close code

    /// An explicit `auth_result success=false` is definitive regardless of
    /// how the socket subsequently closed.
    func testExplicitRejectionIsRejected() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .rejected, closeCode: nil), .rejected)
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .rejected, closeCode: 1000), .rejected)
    }

    /// Close 1008 is the desktop's auth-cooldown policy close — the desktop
    /// delivered no verdict on this identity. Must NOT classify as rejected;
    /// this is the exact frame from the live incident.
    func testStreamEndedWithCooldownClose1008IsTransient() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 1008), .transient)
    }

    /// A socket that died without any close frame ("Socket is not connected",
    /// connection refused, timeout) carries no verdict.
    func testStreamEndedWithoutCloseFrameIsTransient() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: nil), .transient)
    }

    /// Application close codes are identity-level refusals: 4003 = unknown /
    /// removed device. Definitive even without an `auth_result` frame.
    func testApplicationClose4003IsRejected() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 4003), .rejected)
    }

    /// The whole 4000–4999 application band is a rejection; its boundaries
    /// are exclusive of neighboring protocol codes.
    func testApplicationCloseBandBoundaries() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 4000), .rejected)
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 4999), .rejected)
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 3999), .transient)
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 5000), .transient)
    }

    /// Normal-closure and going-away protocol codes carry no auth verdict.
    func testProtocolClosesAreTransient() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 1000), .transient)
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 1001), .transient)
    }

    /// A successful handshake stays successful; a stale close code from the
    /// transport must never demote it.
    func testSuccessIsNeverReclassified() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .success, closeCode: nil), .success)
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .success, closeCode: 4003), .success)
    }

    // MARK: - verdict(fromAuthFrame:) — real frame shapes

    private func json(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }

    /// Bare `auth_result success=false` — the desktop actively refused.
    func testBareAuthResultFailureIsRejected() throws {
        let frame = try json(#"{"type":"auth_result","success":false,"reason":"unknown device"}"#)
        XCTAssertEqual(LANAuthOutcome.verdict(fromAuthFrame: frame), .rejected)
    }

    /// Bare `auth_result success=true`.
    func testBareAuthResultSuccess() throws {
        let frame = try json(#"{"type":"auth_result","success":true}"#)
        XCTAssertEqual(LANAuthOutcome.verdict(fromAuthFrame: frame), .success)
    }

    /// `auth_result` wrapped in a WireMessage envelope (payload string).
    func testWireWrappedAuthResultFailureIsRejected() throws {
        let frame = try json(#"{"seq":0,"payload":"{\"type\":\"auth_result\",\"success\":false}"}"#)
        XCTAssertEqual(LANAuthOutcome.verdict(fromAuthFrame: frame), .rejected)
    }

    func testWireWrappedAuthResultSuccess() throws {
        let frame = try json(#"{"seq":0,"payload":"{\"type\":\"auth_result\",\"success\":true}"}"#)
        XCTAssertEqual(LANAuthOutcome.verdict(fromAuthFrame: frame), .success)
    }

    /// Non-auth frames yield no verdict — the auth loop must keep waiting,
    /// and a stream that ends without a verdict classifies as transient.
    func testNonAuthFrameYieldsNoVerdict() throws {
        XCTAssertNil(LANAuthOutcome.verdict(fromAuthFrame: try json(#"{"type":"desktop_heartbeat","ts":1}"#)))
        XCTAssertNil(LANAuthOutcome.verdict(fromAuthFrame: try json(#"{"seq":1,"payload":"{\"type\":\"desktop_heartbeat\"}"}"#)))
    }
}
