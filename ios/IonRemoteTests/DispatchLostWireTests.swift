import XCTest
@testable import IonRemote

/// desktop_dispatch_lost — the wire shape and the scrollback wording.
///
/// The engine announces one of these per dispatch that was running when the
/// engine process died. The desktop forwards it through its generic
/// engine→wire projection, so iOS receives the engine's own `dispatchLost`
/// payload envelope verbatim.
///
/// The divider wording is pinned here and in the desktop's
/// clear-divider.test.ts. A conversation open on both devices must read the
/// same, so a reword is a two-platform change and one of these two tests will
/// catch a one-sided edit.
final class DispatchLostWireTests: XCTestCase {

    func testDispatchLostDecodesDesktopWireShape() throws {
        let json = #"{"type":"desktop_dispatch_lost","tabId":"tab-1","instanceId":"main","dispatchLost":{"dispatchId":"dispatch-agent-2-1789044109138-097110fdb688","agentName":"agent-2","task":"review the diff","childConversationId":"conv-child-1"}}"#
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json.data(using: .utf8)!)

        guard case .engineDispatchLost(let tabId, let instanceId, let lost) = event else {
            return XCTFail("expected engineDispatchLost")
        }
        XCTAssertEqual(tabId, "tab-1")
        XCTAssertEqual(instanceId, "main")
        XCTAssertEqual(lost.dispatchId, "dispatch-agent-2-1789044109138-097110fdb688")
        XCTAssertEqual(lost.agentName, "agent-2")
        XCTAssertEqual(lost.childConversationId, "conv-child-1")
    }

    func testDispatchLostRoundTripsUnderTheContractKey() throws {
        let json = #"{"type":"desktop_dispatch_lost","tabId":"tab-1","dispatchLost":{"dispatchId":"d-1","agentName":"agent-1"}}"#
        let event = try JSONDecoder().decode(RemoteEvent.self, from: json.data(using: .utf8)!)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as! [String: Any]

        XCTAssertEqual(encoded["type"] as? String, "desktop_dispatch_lost")
        // The payload rides its own envelope key, not flattened onto the event:
        // a flattened shape would collide with other variants' primitives.
        let payload = encoded["dispatchLost"] as? [String: Any]
        XCTAssertEqual(payload?["dispatchId"] as? String, "d-1")
        XCTAssertEqual(payload?["agentName"] as? String, "agent-1")
    }

    func testDividerNamesTheAgentAndTheRestart() {
        var components = DateComponents()
        components.year = 2026; components.month = 9; components.day = 10
        components.hour = 13; components.minute = 0
        let time = Calendar.current.date(from: components)!

        let text = SessionViewModel.dispatchLostDividerText(at: time, agentName: "agent-2")
        XCTAssertTrue(text.contains("agent-2 was lost when the engine restarted at"), text)
        XCTAssertTrue(text.hasPrefix("── "), text)
    }

    func testDividerFallsBackWhenTheOrphanIsUnattributed() {
        let text = SessionViewModel.dispatchLostDividerText(at: Date(), agentName: "")
        XCTAssertTrue(text.contains("agent was lost when the engine restarted at"), text)
    }
}
