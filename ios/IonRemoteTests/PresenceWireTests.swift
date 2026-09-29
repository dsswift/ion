import XCTest
@testable import IonRemote

/// FR-02 presence wire parity -- `desktop_presence` (desktop → iOS). Pushed
/// independently of `desktop_snapshot` (server/src/remote/transport-init.ts,
/// server/src/broadcast.ts's `studio:presence` re-projection); the desktop
/// owns this wire (ADR-008) and it is lockstep -- a rename ships to both
/// sides in one change.
final class PresenceWireTests: XCTestCase {

    func testDecodesPresenceEvent() throws {
        let json = """
        {
          "type": "desktop_presence",
          "entries": [
            {"subject": "oidc:alice", "displayName": "Alice", "focusedTabId": "tab-1"},
            {"subject": "oidc:bob", "displayName": "Bob", "focusedTabId": null}
          ],
          "driving": {"tab-1": "oidc:alice"}
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .presence(entries, driving) = event else {
            return XCTFail("decoded to the wrong case: \(event)")
        }
        XCTAssertEqual(entries, [
            PresenceEntry(subject: "oidc:alice", displayName: "Alice", focusedTabId: "tab-1"),
            PresenceEntry(subject: "oidc:bob", displayName: "Bob", focusedTabId: nil),
        ])
        XCTAssertEqual(driving, ["tab-1": "oidc:alice"])
    }

    func testDecodesAnEmptyPresenceSnapshot() throws {
        let json = """
        {"type": "desktop_presence", "entries": [], "driving": {}}
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)

        guard case let .presence(entries, driving) = event else {
            return XCTFail("decoded to the wrong case: \(event)")
        }
        XCTAssertTrue(entries.isEmpty)
        XCTAssertTrue(driving.isEmpty)
    }

    @MainActor
    func testHandlePresenceReplacesStateWholesaleAndExposesLookups() {
        let viewModel = SessionViewModel()
        let entries = [
            PresenceEntry(subject: "oidc:alice", displayName: "Alice", focusedTabId: "tab-1"),
            PresenceEntry(subject: "oidc:bob", displayName: "Bob", focusedTabId: "tab-1"),
        ]
        let driving = ["tab-1": "oidc:bob"]

        viewModel.handlePresence(entries: entries, driving: driving)

        XCTAssertEqual(viewModel.presenceEntries, entries)
        XCTAssertEqual(viewModel.presenceFocusedOn("tab-1").map(\.subject).sorted(), ["oidc:alice", "oidc:bob"])
        XCTAssertTrue(viewModel.presenceFocusedOn("tab-2").isEmpty)
        XCTAssertEqual(viewModel.drivingSubject(forTab: "tab-1"), "oidc:bob")
        XCTAssertNil(viewModel.drivingSubject(forTab: "tab-2"))

        // A later push replaces wholesale, not merges.
        viewModel.handlePresence(entries: [], driving: [:])
        XCTAssertTrue(viewModel.presenceEntries.isEmpty)
        XCTAssertNil(viewModel.drivingSubject(forTab: "tab-1"))
    }
}
