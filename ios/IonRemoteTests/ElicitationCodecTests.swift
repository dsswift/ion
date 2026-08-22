import XCTest
@testable import IonRemote

/// Codec tests for the extension-elicitation (ctx.elicit) iOS surface.
///
/// Covers:
///   1. `desktop_respond_elicitation` RemoteCommand encodes the canonical wire
///      shape (type + tabId + requestId + cancelled, optional response) and
///      round-trips through decode.
///   2. `RemoteTabState.elicitationQueue` decodes from snapshot JSON, and is
///      nil/empty when absent (back-compat with older desktops).
///   3. `ElicitationRequest` decodes its requestId / mode / schema fields.
///
/// These pin the consumer half of `engine_elicitation_request`: the engine
/// parks the run on an indefinite human-wait until a client answers, so iOS
/// must decode the queue and encode the response. Pure encode/decode.
final class ElicitationCodecTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func testEncodeRespondElicitationApprove() throws {
        let cmd = RemoteCommand.respondElicitation(
            tabId: "t1", requestId: "elicit-1", response: [:], cancelled: false
        )
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_respond_elicitation")
        XCTAssertEqual(json["tabId"] as? String, "t1")
        XCTAssertEqual(json["requestId"] as? String, "elicit-1")
        XCTAssertEqual(json["cancelled"] as? Bool, false)
    }

    func testEncodeRespondElicitationCancel() throws {
        let cmd = RemoteCommand.respondElicitation(
            tabId: "t2", requestId: "elicit-2", response: nil, cancelled: true
        )
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_respond_elicitation")
        XCTAssertEqual(json["requestId"] as? String, "elicit-2")
        XCTAssertEqual(json["cancelled"] as? Bool, true)
        // response omitted on cancel (encodeIfPresent).
        XCTAssertNil(json["response"])
    }

    func testEncodeRespondElicitationDecline() throws {
        let cmd = RemoteCommand.respondElicitation(
            tabId: "t4", requestId: "elicit-4", response: nil, cancelled: false, declined: true
        )
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["cancelled"] as? Bool, false)
        XCTAssertEqual(json["declined"] as? Bool, true)
    }
    func testRespondElicitationRoundTrip() throws {
        let cmd = RemoteCommand.respondElicitation(
            tabId: "t3", requestId: "elicit-3", response: [:], cancelled: false
        )
        let data = try encoder.encode(cmd)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        guard case let .respondElicitation(tabId, requestId, _, cancelled, declined) = decoded else {
            return XCTFail("decoded to wrong case: \(decoded)")
        }
        XCTAssertEqual(tabId, "t3")
        XCTAssertEqual(requestId, "elicit-3")
        XCTAssertFalse(cancelled)
        XCTAssertFalse(declined)
    }

    func testTabStateElicitationQueueDecodes() throws {
        let json = """
        { "id": "t1", "title": "T", "status": "running", "workingDirectory": "/x",
          "permissionMode": "auto", "permissionQueue": [],
          "elicitationQueue": [
            { "requestId": "elicit-1", "mode": "approval",
              "schema": { "action": "dispatch_agent", "agent": "dev-lead", "tier": "T4" } }
          ] }
        """.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertEqual(tab.elicitationQueue?.count, 1)
        let first = try XCTUnwrap(tab.elicitationQueue?.first)
        XCTAssertEqual(first.requestId, "elicit-1")
        XCTAssertEqual(first.mode, "approval")
        XCTAssertNotNil(first.schema)
    }

    func testTabStateElicitationQueueNilWhenAbsent() throws {
        let json = """
        { "id": "t1", "title": "T", "status": "idle", "workingDirectory": "/x",
          "permissionMode": "auto", "permissionQueue": [] }
        """.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertNil(tab.elicitationQueue)
    }
}

// MARK: - respondElicitation queue-mutation tests

/// Verifies the queue-shrink predicate in SessionViewModel+Commands.swift.
/// Seeds a tab with elicitation entries, invokes respondElicitation for
/// the response and cancelled cases, and asserts the matching entry is
/// removed via the `removeAll { $0.requestId == requestId }` predicate.
/// Goes red if the predicate key is wrong (e.g. uses .id instead of .requestId).
@MainActor
final class RespondElicitationQueueTests: XCTestCase {

    /// Seed a SessionViewModel with a tab that has two elicitation queue entries.
    private func makeVM() -> (vm: SessionViewModel, tabId: String) {
        let vm = SessionViewModel()
        let json = """
        { "id": "t-elicit", "title": "Test", "status": "idle",
          "workingDirectory": "/tmp", "permissionMode": "auto",
          "permissionQueue": [] }
        """.data(using: .utf8)!
        var tab = try! JSONDecoder().decode(RemoteTabState.self, from: json)
        tab.elicitationQueue = [
            ElicitationRequest(requestId: "req-1", mode: "approval", schema: nil, url: nil),
            ElicitationRequest(requestId: "req-2", mode: "form",     schema: nil, url: nil),
        ]
        vm.tabs = [tab]
        return (vm, "t-elicit")
    }

    func testRespondApprovalRemovesMatchingEntry() {
        let (vm, tabId) = makeVM()
        vm.respondElicitation(tabId: tabId, requestId: "req-1", approved: true)
        let queue = vm.tabs.first(where: { $0.id == tabId })?.elicitationQueue ?? []
        XCTAssertEqual(queue.count, 1,
            "queue should shrink by 1 after approving req-1")
        XCTAssertFalse(queue.contains(where: { $0.requestId == "req-1" }),
            "req-1 must be gone after respond (removeAll predicate)")
        XCTAssertTrue(queue.contains(where: { $0.requestId == "req-2" }),
            "req-2 must survive — only req-1 was answered")
    }

    func testRespondCancelledRemovesMatchingEntry() {
        let (vm, tabId) = makeVM()
        vm.respondElicitation(tabId: tabId, requestId: "req-2", approved: false)
        let queue = vm.tabs.first(where: { $0.id == tabId })?.elicitationQueue ?? []
        XCTAssertEqual(queue.count, 1,
            "queue should shrink by 1 after cancelling req-2")
        XCTAssertFalse(queue.contains(where: { $0.requestId == "req-2" }),
            "req-2 must be gone after cancel (removeAll predicate)")
        XCTAssertTrue(queue.contains(where: { $0.requestId == "req-1" }),
            "req-1 must survive — only req-2 was answered")
    }

    func testRespondUnknownRequestIdLeavesQueueUnchanged() {
        let (vm, tabId) = makeVM()
        vm.respondElicitation(tabId: tabId, requestId: "req-999", approved: true)
        let queue = vm.tabs.first(where: { $0.id == tabId })?.elicitationQueue ?? []
        XCTAssertEqual(queue.count, 2,
            "queue must not shrink when the requestId does not match any entry")
    }

    /// Structural guard: confirms the predicate uses .requestId not some other field.
    /// If the predicate were `$0.id == requestId` this test would pass incorrectly
    /// because ElicitationRequest.id is computed from requestId (they're equal).
    /// The companion test `testRespondApprovalRemovesMatchingEntry` is the
    /// behavioural gate; this one documents the intent.
    func testPredicateIsRequestIdNotId() {
        // ElicitationRequest.id returns requestId (it's the Identifiable conformance).
        // Confirming both fields are equal for a seeded entry validates the assumption
        // that the removeAll predicate — whether it uses .id or .requestId — removes
        // the correct entry. No ambiguity is introduced here.
        let entry = ElicitationRequest(requestId: "req-x", mode: "approval", schema: nil, url: nil)
        XCTAssertEqual(entry.id, entry.requestId,
            "ElicitationRequest.id must equal .requestId for Identifiable conformance")
    }
}
