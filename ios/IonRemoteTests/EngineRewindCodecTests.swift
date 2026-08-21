import XCTest
@testable import IonRemote

/// Codec tests for the engine_rewind command (iOS -> desktop) and the
/// instanceId-carrying input_prefill event (desktop -> iOS) that completes
/// the engine-tab rewind round-trip. Mirrors EngineMoveCodecTests' style:
/// pure encode/decode, no network or MainActor required.
final class EngineRewindCodecTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - engine_rewind command encode

    func testEncodeEngineRewind() throws {
        let cmd = RemoteCommand.engineRewind(
            tabId: "tab-a",
            instanceId: "inst-1",
            messageId: "msg-7",
            userTurnIndex: 2
        )
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "desktop_engine_rewind")
        XCTAssertEqual(json["tabId"] as? String, "tab-a")
        XCTAssertEqual(json["instanceId"] as? String, "inst-1")
        XCTAssertEqual(json["messageId"] as? String, "msg-7")
        XCTAssertEqual(json["userTurnIndex"] as? Int, 2)
    }

    func testEncodeEngineRewindWithoutUserTurnIndex() throws {
        // Nil userTurnIndex omits the wire key (encodeIfPresent).
        let cmd = RemoteCommand.engineRewind(
            tabId: "tab-a",
            instanceId: "inst-1",
            messageId: "msg-7",
            userTurnIndex: nil
        )
        let data = try encoder.encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNil(json["userTurnIndex"])
    }

    // MARK: - engine_rewind command decode

    func testDecodeEngineRewind() throws {
        let json = """
        {
            "type": "desktop_engine_rewind",
            "tabId": "tab-a",
            "instanceId": "inst-1",
            "messageId": "msg-7",
            "userTurnIndex": 3
        }
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)

        if case .engineRewind(let tabId, let instanceId, let messageId, let userTurnIndex) = cmd {
            XCTAssertEqual(tabId, "tab-a")
            XCTAssertEqual(instanceId, "inst-1")
            XCTAssertEqual(messageId, "msg-7")
            XCTAssertEqual(userTurnIndex, 3)
        } else {
            XCTFail("Expected engineRewind, got \(cmd)")
        }
    }

    func testDecodeEngineRewindWithoutUserTurnIndex() throws {
        let json = """
        {
            "type": "desktop_engine_rewind",
            "tabId": "tab-a",
            "instanceId": "inst-1",
            "messageId": "msg-7"
        }
        """.data(using: .utf8)!

        let cmd = try decoder.decode(RemoteCommand.self, from: json)

        if case .engineRewind(_, _, _, let userTurnIndex) = cmd {
            // Absent wire key decodes to nil (decodeIfPresent).
            XCTAssertNil(userTurnIndex)
        } else {
            XCTFail("Expected engineRewind, got \(cmd)")
        }
    }

    // MARK: - engine_rewind command round-trip

    func testRoundTripEngineRewind() throws {
        let original = RemoteCommand.engineRewind(
            tabId: "round-tab",
            instanceId: "round-inst",
            messageId: "round-msg",
            userTurnIndex: 5
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteCommand.self, from: data)

        if case .engineRewind(let tabId, let instanceId, let messageId, let userTurnIndex) = decoded {
            XCTAssertEqual(tabId, "round-tab")
            XCTAssertEqual(instanceId, "round-inst")
            XCTAssertEqual(messageId, "round-msg")
            XCTAssertEqual(userTurnIndex, 5)
        } else {
            XCTFail("Round-trip engineRewind failed, got \(decoded)")
        }
    }

    // MARK: - input_prefill event with instanceId (engine_rewind reply)

    func testDecodeInputPrefillWithInstanceId() throws {
        let json = """
        {
            "type": "desktop_input_prefill",
            "tabId": "tab-a",
            "text": "the rewound prompt",
            "instanceId": "inst-1"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)

        if case .inputPrefill(let tabId, let text, let switchTo, let instanceId) = event {
            XCTAssertEqual(tabId, "tab-a")
            XCTAssertEqual(text, "the rewound prompt")
            XCTAssertFalse(switchTo)
            XCTAssertEqual(instanceId, "inst-1")
        } else {
            XCTFail("Expected inputPrefill, got \(event)")
        }
    }

    // MARK: - input_prefill event without instanceId (CLI-tab rewind)

    func testDecodeInputPrefillWithoutInstanceId() throws {
        let json = """
        {
            "type": "desktop_input_prefill",
            "tabId": "tab-a",
            "text": "cli prompt"
        }
        """.data(using: .utf8)!

        let event = try decoder.decode(RemoteEvent.self, from: json)

        if case .inputPrefill(let tabId, let text, let switchTo, let instanceId) = event {
            XCTAssertEqual(tabId, "tab-a")
            XCTAssertEqual(text, "cli prompt")
            XCTAssertFalse(switchTo)
            // instanceId absent in JSON decodes to nil (CLI rewind path).
            XCTAssertNil(instanceId)
        } else {
            XCTFail("Expected inputPrefill, got \(event)")
        }
    }

    // MARK: - Fork command (one shared conversation pipeline)

    /// Fork is one client-local conversation operation on the desktop. It does
    /// not branch on a tab profile, so iOS sends the same desktop_fork_from_message
    /// command for Plain and extension-hosted tabs alike.
    func testRoundTripForkFromMessage() throws {
        let original = RemoteCommand.forkFromMessage(tabId: "fork-tab", messageId: "entry-7")
        let data = try encoder.encode(original)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "desktop_fork_from_message")
        XCTAssertEqual(json["tabId"] as? String, "fork-tab")
        XCTAssertEqual(json["messageId"] as? String, "entry-7")

        let decoded = try decoder.decode(RemoteCommand.self, from: data)
        if case .forkFromMessage(let tabId, let messageId) = decoded {
            XCTAssertEqual(tabId, "fork-tab")
            XCTAssertEqual(messageId, "entry-7")
        } else {
            XCTFail("Round-trip forkFromMessage failed, got \(decoded)")
        }
    }

    // MARK: - Fork prefill reaches the visible draft store

    /// Fork replies use desktop_input_prefill with no instanceId. The visible
    /// composer reads the unified bare-tab draft store, so this shape must write
    /// there — the retired prefill map was never read by any view.
    @MainActor
    func testForkInputPrefillWritesUnifiedTabDraftAndNavigates() {
        let viewModel = SessionViewModel()

        viewModel.handleInputPrefill(
            tabId: "fork-tab",
            text: "continue from this message",
            switchTo: true,
            instanceId: nil
        )

        XCTAssertEqual(viewModel.tabDraft("fork-tab"), "continue from this message")
        XCTAssertEqual(viewModel.pendingNavigationTabId, "fork-tab")
    }

    // MARK: - input_prefill round-trip preserves instanceId

    func testRoundTripInputPrefillInstanceId() throws {
        let original = RemoteEvent.inputPrefill(
            tabId: "t1",
            text: "round",
            switchTo: false,
            instanceId: "inst-9"
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)

        if case .inputPrefill(_, _, _, let instanceId) = decoded {
            XCTAssertEqual(instanceId, "inst-9")
        } else {
            XCTFail("Round-trip inputPrefill failed, got \(decoded)")
        }
    }
}
