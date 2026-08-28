import XCTest
@testable import IonRemote

final class TranscriptWireTests: XCTestCase {
    func testRequestTranscriptRoundTrips() throws {
        let command = RemoteCommand.requestTranscript(tabId: "tab-1", requestId: "request-1")
        let data = try JSONEncoder().encode(command)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(json["type"] as? String, "desktop_request_transcript")
        XCTAssertEqual(json["tabId"] as? String, "tab-1")
        XCTAssertEqual(json["requestId"] as? String, "request-1")

        guard case let .requestTranscript(tabId, requestId) = try JSONDecoder().decode(RemoteCommand.self, from: data) else {
            return XCTFail("Expected requestTranscript")
        }
        XCTAssertEqual(tabId, "tab-1")
        XCTAssertEqual(requestId, "request-1")
    }

    func testTranscriptResponseRoundTrips() throws {
        let event = RemoteEvent.transcript(
            tabId: "tab-1",
            requestId: "request-1",
            transcript: "[user]: Hello",
            error: nil
        )
        let data = try JSONEncoder().encode(event)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "desktop_transcript")

        guard case let .transcript(tabId, requestId, transcript, error) = try JSONDecoder().decode(RemoteEvent.self, from: data) else {
            return XCTFail("Expected transcript")
        }
        XCTAssertEqual(tabId, "tab-1")
        XCTAssertEqual(requestId, "request-1")
        XCTAssertEqual(transcript, "[user]: Hello")
        XCTAssertNil(error)
    }

    func testTranscriptErrorDecodes() throws {
        let data = #"{"type":"desktop_transcript","tabId":"tab-1","requestId":"request-1","transcript":"","error":"not found"}"#.data(using: .utf8)!
        guard case let .transcript(_, _, transcript, error) = try JSONDecoder().decode(RemoteEvent.self, from: data) else {
            return XCTFail("Expected transcript")
        }
        XCTAssertEqual(transcript, "")
        XCTAssertEqual(error, "not found")
    }

    func testSessionIdsDecodeFromSnapshotTab() throws {
        let data = #"{"id":"tab-1","title":"Test","status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"sessionIds":["old","current"]}"#.data(using: .utf8)!
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: data)
        XCTAssertEqual(tab.sessionIds, ["old", "current"])
    }
}
