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

    // MARK: - engine_rewind command decode

    // MARK: - engine_rewind command round-trip

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
