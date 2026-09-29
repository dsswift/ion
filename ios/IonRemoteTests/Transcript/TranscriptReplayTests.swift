import XCTest
@testable import IonRemote

/// The phone replays patches the REAL server produced and must end holding
/// exactly the server's rows.
///
/// `transcript-replay.json` is written by
/// `server/src/transcript/__tests__/transcript-replay-fixture.test.ts`, which
/// drives the server store's own reducer through a real run (streamed text, a
/// tool with streamed input, message ends, thinking, a stream reset, a
/// relocated harness notice, a steer, a rewind) and records every patch the
/// publisher sent. This test decodes each patch through the same path a live
/// one takes (`RemoteEvent` decoding into `handleEvent`), so a drift in the
/// wire shape, the decoder, or the apply rule fails here rather than on a
/// phone.
@MainActor
final class TranscriptReplayTests: XCTestCase {

    private static let epoch = "fixture-epoch"

    private func fixture() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/shared/src/transcript/__fixtures__/transcript-replay.json")
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func rows(_ json: Any) throws -> [Message] {
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode([TranscriptRow].self, from: data).map(\.message)
    }

    /// A row as the wire carries it, with the flags the server may send as
    /// explicit `false` and the phone omits normalized away.
    private func normalized(_ row: Any) -> NSDictionary {
        var dict = (row as? [String: Any]) ?? [:]
        for (key, value) in dict where (value as? Bool) == false || value is NSNull {
            dict.removeValue(forKey: key)
        }
        return dict as NSDictionary
    }

    func testReplayingTheServersPatchesReproducesTheServersRows() throws {
        let fixture = try fixture()
        let snapshot = try XCTUnwrap(fixture["snapshot"] as? [String: Any])
        let patches = try XCTUnwrap(fixture["patches"] as? [[String: Any]])
        let final = try XCTUnwrap(fixture["final"] as? [Any])
        XCTAssertFalse(patches.isEmpty)

        let vm = SessionViewModel()
        let tabId = try XCTUnwrap(patches.first?["tabId"] as? String)
        vm.tabs = [TranscriptTestSupport.tab(tabId)]
        let snapshotRows = try rows(snapshot["rows"] as Any)
        vm.handleTranscriptPage(TranscriptPage(
            tabId: tabId, instanceId: "main",
            streamId: try XCTUnwrap(snapshot["streamId"] as? String),
            epoch: Self.epoch,
            rev: try XCTUnwrap(snapshot["rev"] as? Int),
            total: snapshotRows.count, startIndex: 0, rows: snapshotRows,
            hasOlder: false, isNewest: true
        ))

        for (index, patch) in patches.enumerated() {
            var wire = patch
            wire["epoch"] = Self.epoch
            let data = try JSONSerialization.data(withJSONObject: wire)
            let event = try JSONDecoder().decode(RemoteEvent.self, from: data)
            guard case .transcriptPatch = event else {
                return XCTFail("patch \(index) decoded as \(event)")
            }
            vm.handleEvent(event)
            XCTAssertFalse(vm.transcriptResyncing.contains(tabId), "patch \(index) did not apply cleanly")
        }

        let held = vm.conversationMessages(tabId)
        XCTAssertEqual(held.count, final.count)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(held.map(TranscriptRow.init(message:)))) as? [Any] ?? []
        XCTAssertEqual(encoded.map(normalized), final.map(normalized),
            "the phone must hold exactly the rows the server's store holds")
    }
}
