import XCTest
@testable import IonRemote

/// Behavior tests for the harness-message dedup/relocate logic
/// (handleEngineHarnessMessage in SessionViewModel+EngineEvents.swift).
///
/// Three dedup paths pinned:
///
///   1. dedupMode "relocate" + dedupKey present: remove any existing message
///      with that key, append the new one at the end. Exactly one marker with
///      the given key exists after the second emission, at the trailing position.
///
///   2. dedupKey present (no dedupMode): suppress-later — second emission with
///      the same key is dropped; only one message with that key.
///
///   3. No dedupKey: append unconditionally — both messages arrive.
///
/// Reverting handleEngineHarnessMessage to the pre-dedup append-only behavior
/// turns test 1 and 2 red. A regression that drops all messages turns test 3 red.
@MainActor
final class HarnessMessageRelocateTests: XCTestCase {

    private let tabId = "tab-relo"
    private let instanceId = "inst-relo"

    private func makeViewModel() -> SessionViewModel {
        let vm = SessionViewModel()
        vm.conversationInstances[tabId] = [
            ConversationInstanceInfo(id: instanceId, label: "primary")
        ]
        vm.activeEngineInstance[tabId] = instanceId
        return vm
    }

    private func messages(_ vm: SessionViewModel) -> [Message] {
        vm.conversationInstances[tabId]?.first?.messages ?? []
    }

    // MARK: - Relocate (dedupMode == "relocate")

    /// A second relocate-keyed harness message REPLACES (not stacks) the first.
    /// After two emissions with the same key and dedupMode "relocate", exactly
    /// one message with that key exists in the transcript, at the trailing position.
    func testRelocate_secondEmissionReplacesFirst() async {
        let vm = makeViewModel()
        let key = "ion-meta:bootstrap"

        // First emission.
        vm.handleEngineHarnessMessage(
            tabId: tabId,
            instanceId: instanceId,
            message: "Session bootstrapped (first)",
            dedupKey: key,
            dedupMode: "relocate"
        )

        // Interleave a regular assistant message so we can verify the relocated
        // marker moves to the end and does not land beside the first emission.
        let assistantMsg = Message(
            id: "a1",
            role: .assistant,
            content: "Here is the plan.",
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        vm.mutateEngineInstance(tabId: tabId, instanceId: instanceId) {
            $0.messages.append(assistantMsg)
        }

        // Second emission with the same key — should relocate to the end.
        vm.handleEngineHarnessMessage(
            tabId: tabId,
            instanceId: instanceId,
            message: "Session bootstrapped (second)",
            dedupKey: key,
            dedupMode: "relocate"
        )

        let msgs = messages(vm)

        // Exactly one marker with the key.
        let keyed = msgs.filter { $0.dedupKey == key }
        XCTAssertEqual(keyed.count, 1,
            "Exactly one marker with dedupKey '\(key)' expected after relocate; got \(keyed.count)")

        // The surviving marker carries the second emission's content.
        XCTAssertEqual(keyed.first?.content, "Session bootstrapped (second)",
            "Surviving marker must carry the newest content after relocate")

        // The marker is the last message (at the end).
        XCTAssertEqual(msgs.last?.dedupKey, key,
            "Relocated marker must be at the trailing position in the transcript")

        // The assistant message is before the relocated marker.
        XCTAssertTrue(
            msgs.firstIndex(where: { $0.id == "a1" }) ?? Int.max
            < msgs.firstIndex(where: { $0.dedupKey == key }) ?? Int.min,
            "Assistant message must precede the relocated marker"
        )
    }

    /// With dedupMode "relocate" and a fresh key (no prior marker), the message
    /// is simply appended — no crash, no ghost removal.
    func testRelocate_firstEmission_appendsNormally() async {
        let vm = makeViewModel()

        vm.handleEngineHarnessMessage(
            tabId: tabId,
            instanceId: instanceId,
            message: "Session bootstrapped",
            dedupKey: "ion-meta:bootstrap",
            dedupMode: "relocate"
        )

        let msgs = messages(vm)
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs.first?.content, "Session bootstrapped")
    }

    // MARK: - Suppress-later (dedupKey, no dedupMode)

    /// Second emission with the same dedupKey (no dedupMode) is suppressed.
    /// Only the FIRST message survives.
    func testSuppressLater_duplicateDropped() async {
        let vm = makeViewModel()
        let key = "ion-meta:welcome"

        vm.handleEngineHarnessMessage(
            tabId: tabId,
            instanceId: instanceId,
            message: "Welcome (first)",
            dedupKey: key,
            dedupMode: nil
        )
        vm.handleEngineHarnessMessage(
            tabId: tabId,
            instanceId: instanceId,
            message: "Welcome (second)",
            dedupKey: key,
            dedupMode: nil
        )

        let keyed = messages(vm).filter { $0.dedupKey == key }
        XCTAssertEqual(keyed.count, 1, "Second emission with same dedupKey must be suppressed")
        XCTAssertEqual(keyed.first?.content, "Welcome (first)",
            "First emission must be the surviving message in suppress-later mode")
    }

    // MARK: - No dedupKey

    /// Without a dedupKey both messages are appended unconditionally.
    func testNoDedupKey_bothAppend() async {
        let vm = makeViewModel()

        vm.handleEngineHarnessMessage(
            tabId: tabId,
            instanceId: instanceId,
            message: "First status",
            dedupKey: nil,
            dedupMode: nil
        )
        vm.handleEngineHarnessMessage(
            tabId: tabId,
            instanceId: instanceId,
            message: "Second status",
            dedupKey: nil,
            dedupMode: nil
        )

        let msgs = messages(vm)
        XCTAssertEqual(msgs.count, 2, "Both messages must append when no dedupKey is present")
        XCTAssertEqual(msgs.first?.content, "First status")
        XCTAssertEqual(msgs.last?.content, "Second status")
    }

    // MARK: - Wire decode: dedupKey / dedupMode survive NormalizedEvent round-trip

    /// dedupKey and dedupMode on engineHarnessMessage survive a JSON encode →
    /// decode round-trip so they are correctly propagated to the handler.
    func testWireDecode_dedupKeyAndModeDecodeFromJSON() throws {
        let json = """
        {
          "type": "desktop_harness_message",
          "tabId": "tab-1",
          "instanceId": "inst-1",
          "message": "Session bootstrapped",
          "dedupKey": "ion-meta:bootstrap",
          "dedupMode": "relocate"
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .engineHarnessMessage(_, _, let message, _, _, let dk, let dm) = event else {
            XCTFail("Expected .engineHarnessMessage; got \(event)")
            return
        }
        XCTAssertEqual(message, "Session bootstrapped")
        XCTAssertEqual(dk, "ion-meta:bootstrap",
            "dedupKey must decode from top-level wire field")
        XCTAssertEqual(dm, "relocate",
            "dedupMode must decode from top-level wire field")
    }

    /// History-replay messages carrying dedupKey/dedupMode are decoded correctly
    /// by the standard Codable Message init (desktop_conversation_history path).
    func testHistoryReplay_dedupKeyDecodesFromMessage() throws {
        let json = """
        {
          "id": "msg-1",
          "role": "harness",
          "content": "Session bootstrapped",
          "timestamp": 1700000000000,
          "dedupKey": "ion-meta:bootstrap",
          "dedupMode": "relocate"
        }
        """.data(using: .utf8)!

        let msg = try JSONDecoder().decode(Message.self, from: json)
        XCTAssertEqual(msg.dedupKey, "ion-meta:bootstrap",
            "dedupKey must decode from history-replay message payload")
        XCTAssertEqual(msg.dedupMode, "relocate",
            "dedupMode must decode from history-replay message payload")
    }
}
