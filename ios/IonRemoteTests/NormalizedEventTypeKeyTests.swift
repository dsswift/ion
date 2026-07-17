import XCTest
@testable import IonRemote

/// Tests for the NormalizedEvent.typeKey computed property (commit 9).
///
/// Pinning test: verifies that typeKey returns the correct wire type string
/// for representative RemoteEvent cases. Without this property, the per-frame
/// receive latency logging in TransportManager+Receive.swift would fail to
/// compile.
///
/// Also pins the lenient-decode contract: unknown type strings throw
/// RemoteEventDecodeError.unknownType (not DecodingError), so
/// TransportManager+Receive.swift can handle them at trace level without
/// triggering a resync.
final class NormalizedEventTypeKeyTests: XCTestCase {
    func testHeartbeatTypeKey() {
        let event = RemoteEvent.heartbeat(senderTs: 1_700_000_000_000.0, buffered: 0)
        XCTAssertEqual(event.typeKey, "desktop_heartbeat")
    }

    func testSnapshotTypeKey() throws {
        // Build a minimal snapshot JSON and decode it so we have a real .snapshot case.
        let json = """
        {"type":"desktop_snapshot","tabs":[],"recentDirectories":[],"tabGroupMode":"off","tabGroups":[]}
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        XCTAssertEqual(event.typeKey, "desktop_snapshot")
    }

    func testTabStatusTypeKey() throws {
        let json = """
        {"type":"desktop_tab_status","tabId":"t1","status":"idle"}
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        XCTAssertEqual(event.typeKey, "desktop_tab_status")
    }

    func testTabMetaTypeKey() throws {
        let json = """
        {"type":"desktop_tab_meta","tabId":"t2","title":"My Tab","totalCostUsd":0.0042}
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        XCTAssertEqual(event.typeKey, "desktop_tab_meta")
    }

    // MARK: - Lenient decode contract

    /// An unrecognized type string must throw RemoteEventDecodeError.unknownType,
    /// not a generic DecodingError. This is the regression pin: the
    /// TransportManager+Receive.swift caller catches these two error types
    /// separately — unknown types are dropped at trace level with no resync;
    /// DecodingErrors trigger error-level logging + resync.
    func testUnknownTypeThrowsRemoteEventDecodeError() throws {
        let json = """
        {"type":"desktop_future_unknown_event_xyz","tabId":"abc"}
        """.data(using: .utf8)!
        do {
            _ = try JSONDecoder().decode(RemoteEvent.self, from: json)
            XCTFail("Expected RemoteEventDecodeError.unknownType to be thrown")
        } catch RemoteEventDecodeError.unknownType(let raw) {
            XCTAssertEqual(raw, "desktop_future_unknown_event_xyz")
        } catch {
            XCTFail("Expected RemoteEventDecodeError.unknownType, got \(error)")
        }
    }

    /// A known type with a missing required field must throw DecodingError,
    /// not RemoteEventDecodeError. This pins that real payload corruption still
    /// produces an error-level failure and triggers a resync.
    func testKnownTypeWithMissingRequiredFieldThrowsDecodingError() {
        // desktop_snapshot requires "tabs" — omitting it should fail with DecodingError.
        let json = """
        {"type":"desktop_snapshot"}
        """.data(using: .utf8)!
        do {
            _ = try JSONDecoder().decode(RemoteEvent.self, from: json)
            XCTFail("Expected DecodingError to be thrown")
        } catch is RemoteEventDecodeError {
            XCTFail("Expected DecodingError, not RemoteEventDecodeError — unknown type and bad payload must be distinguished")
        } catch is DecodingError {
            // Correct: a known type with a bad payload is a real decode failure.
            return
        } catch {
            XCTFail("Expected DecodingError, got \(error)")
        }
    }
}
