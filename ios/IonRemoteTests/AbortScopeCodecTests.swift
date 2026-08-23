import XCTest
@testable import IonRemote

/// Codec tests for the scoped-abort wire: `desktop_cancel`'s optional `scope`
/// and the new `desktop_abort_dispatch` command.
///
/// The back-compat arm is the one that matters most. A cancel with no scope
/// must encode to exactly the shape it had before the field existed — a
/// `scope: null` on the wire would be a behavioral change to every stop the app
/// sends, since the desktop reads absent-scope as full teardown.
///
/// Pure encode/decode — no network or MainActor.
final class AbortScopeCodecTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - cancel

    func testCancelWithoutScopeOmitsTheField() throws {
        let cmd = RemoteCommand.cancel(tabId: "t1")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_cancel")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertNil(json["scope"], "an unscoped cancel must not put scope on the wire at all")
    }

    func testCancelWithOrchestratorScopeEncodes() throws {
        let cmd = RemoteCommand.cancel(tabId: "t1", scope: "orchestrator")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_cancel")
        XCTAssertEqual(json["scope"] as? String, "orchestrator")
    }

    func testCancelRoundTripsWithScope() throws {
        let cmd = RemoteCommand.cancel(tabId: "t2", scope: "orchestrator")
        let decoded = try decoder.decode(RemoteCommand.self, from: try encoder.encode(cmd))
        guard case let .cancel(tabId, scope) = decoded else {
            return XCTFail("decoded to wrong case: \(decoded)")
        }
        XCTAssertEqual(tabId, "t2")
        XCTAssertEqual(scope, "orchestrator")
    }

    func testCancelRoundTripsWithoutScope() throws {
        let cmd = RemoteCommand.cancel(tabId: "t3")
        let decoded = try decoder.decode(RemoteCommand.self, from: try encoder.encode(cmd))
        guard case let .cancel(tabId, scope) = decoded else {
            return XCTFail("decoded to wrong case: \(decoded)")
        }
        XCTAssertEqual(tabId, "t3")
        XCTAssertNil(scope, "absent scope must decode as nil so the desktop applies its default")
    }

    /// A cancel frame produced by a client that predates the scope field.
    func testLegacyCancelFrameStillDecodes() throws {
        let json = #"{"type":"desktop_cancel","tabId":"t4"}"#.data(using: .utf8)!
        let decoded = try decoder.decode(RemoteCommand.self, from: json)
        guard case let .cancel(tabId, scope) = decoded else {
            return XCTFail("decoded to wrong case: \(decoded)")
        }
        XCTAssertEqual(tabId, "t4")
        XCTAssertNil(scope)
    }

    // MARK: - abort_dispatch

    func testAbortDispatchEncodes() throws {
        let cmd = RemoteCommand.abortDispatch(tabId: "t1", dispatchId: "dispatch-reviewer-1719-abc")
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_abort_dispatch")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["dispatchId"] as? String, "dispatch-reviewer-1719-abc")
    }

    func testAbortDispatchRoundTrips() throws {
        let cmd = RemoteCommand.abortDispatch(tabId: "t5", dispatchId: "dispatch-x-9")
        let decoded = try decoder.decode(RemoteCommand.self, from: try encoder.encode(cmd))
        guard case let .abortDispatch(tabId, dispatchId) = decoded else {
            return XCTFail("decoded to wrong case: \(decoded)")
        }
        XCTAssertEqual(tabId, "t5")
        XCTAssertEqual(dispatchId, "dispatch-x-9")
    }

    /// The dispatch id must survive verbatim: it is the engine's collision-safe
    /// instance key, and any mangling would address the wrong dispatch or none.
    func testAbortDispatchPreservesFullDispatchId() throws {
        let id = "dispatch-code-reviewer-1719500000000-a1b2c3d4e5f6"
        let cmd = RemoteCommand.abortDispatch(tabId: "t6", dispatchId: id)
        let decoded = try decoder.decode(RemoteCommand.self, from: try encoder.encode(cmd))
        guard case let .abortDispatch(_, dispatchId) = decoded else {
            return XCTFail("decoded to wrong case: \(decoded)")
        }
        XCTAssertEqual(dispatchId, id)
    }
}
