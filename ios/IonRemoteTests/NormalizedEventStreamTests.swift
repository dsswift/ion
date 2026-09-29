import XCTest
@testable import IonRemote

/// Conversation lifecycle events: task completion, prompt results, and rewind
/// results.
final class NormalizedEventStreamTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Decode

    func testDecodeTaskComplete() throws {
        let json = """
        {"type":"desktop_task_complete","tabId":"t1","result":"success","costUsd":0.0042,"durationMs":62007,"reason":"max_turns"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .taskComplete(let tabId, let result, let costUsd, let durationMs, let reason) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(result, "success")
            XCTAssertEqual(costUsd, 0.0042, accuracy: 0.0001)
            XCTAssertEqual(durationMs, 62_007)
            XCTAssertEqual(reason, .maxTurns)
        } else {
            XCTFail("Expected taskComplete, got \(event)")
        }
    }

    func testDecodeTaskCompleteCompatibility() throws {
        let absentJSON = """
        {"type":"desktop_task_complete","tabId":"t1","result":"done","costUsd":0}
        """.data(using: .utf8)!
        if case .taskComplete(_, _, _, let durationMs, let reason) = try decoder.decode(RemoteEvent.self, from: absentJSON) {
            XCTAssertNil(durationMs)
            XCTAssertNil(reason)
        } else {
            XCTFail("Expected taskComplete with absent reason")
        }

        let unknownJSON = """
        {"type":"desktop_task_complete","tabId":"t1","result":"done","costUsd":0,"reason":"future_reason"}
        """.data(using: .utf8)!
        if case .taskComplete(_, _, _, let durationMs, let reason) = try decoder.decode(RemoteEvent.self, from: unknownJSON) {
            XCTAssertNil(durationMs)
            XCTAssertEqual(reason, .unknown("future_reason"))
        } else {
            XCTFail("Expected taskComplete with unknown reason")
        }
    }

    // MARK: - Round-trip

    func testRoundTripTaskComplete() throws {
        let original = RemoteEvent.taskComplete(tabId: "t7", result: "done", costUsd: 1.23, durationMs: 3_661_000, reason: .normal)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .taskComplete(let tabId, let result, let costUsd, let durationMs, let reason) = decoded {
            XCTAssertEqual(tabId, "t7")
            XCTAssertEqual(result, "done")
            XCTAssertEqual(costUsd, 1.23, accuracy: 0.001)
            XCTAssertEqual(durationMs, 3_661_000)
            XCTAssertEqual(reason, .normal)
        } else {
            XCTFail("Round-trip taskComplete failed")
        }
    }

    // MARK: - Prompt result

    func testDecodePromptResultAccepted() throws {
        let json = """
        {"type":"desktop_prompt_result","tabId":"t1","clientMsgId":"msg-abc","status":"accepted"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .promptResult(let tabId, let clientMsgId, let status, let error) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(clientMsgId, "msg-abc")
            XCTAssertEqual(status, "accepted")
            XCTAssertNil(error)
        } else {
            XCTFail("Expected promptResult, got \(event)")
        }
    }

    func testDecodePromptResultRejected() throws {
        let json = """
        {"type":"desktop_prompt_result","tabId":"t2","clientMsgId":"msg-xyz","status":"rejected","error":"no main window"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .promptResult(let tabId, let clientMsgId, let status, let error) = event {
            XCTAssertEqual(tabId, "t2")
            XCTAssertEqual(clientMsgId, "msg-xyz")
            XCTAssertEqual(status, "rejected")
            XCTAssertEqual(error, "no main window")
        } else {
            XCTFail("Expected promptResult, got \(event)")
        }
    }

    func testRoundTripPromptResult() throws {
        let original = RemoteEvent.promptResult(tabId: "t5", clientMsgId: "msg-rt", status: "rejected", error: "timeout")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .promptResult(let tabId, let clientMsgId, let status, let error) = decoded {
            XCTAssertEqual(tabId, "t5")
            XCTAssertEqual(clientMsgId, "msg-rt")
            XCTAssertEqual(status, "rejected")
            XCTAssertEqual(error, "timeout")
        } else {
            XCTFail("Round-trip promptResult failed")
        }
    }

    // MARK: - Engine rewind result (rejection-only notice)

    /// The desktop's rewind is transactional and sends this event ONLY on
    /// refusal (unknown/foreign-branch/non-user target). Round-trips through
    /// JSON to lock in the CodingKeys.
    func testDecodeEngineRewindResult() throws {
        let json = """
        {"type":"desktop_engine_rewind_result","tabId":"t1","instanceId":"i1","status":"rejected","error":"entry is not a user turn on the current path"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineRewindResult(let tabId, let instanceId, let error) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(error, "entry is not a user turn on the current path")
        } else {
            XCTFail("Expected engineRewindResult, got \(event)")
        }
    }

    /// `error` is optional on the wire (the desktop always sends one today,
    /// but the decoder must not throw if a future desktop omits it).
    func testDecodeEngineRewindResultWithoutError() throws {
        let json = """
        {"type":"desktop_engine_rewind_result","tabId":"t1","instanceId":"i1","status":"rejected"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineRewindResult(let tabId, let instanceId, let error) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertNil(error)
        } else {
            XCTFail("Expected engineRewindResult, got \(event)")
        }
    }

    func testRoundTripEngineRewindResult() throws {
        let original = RemoteEvent.engineRewindResult(tabId: "t9", instanceId: "i9", error: "unknown entry")
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineRewindResult(let tabId, let instanceId, let error) = decoded {
            XCTAssertEqual(tabId, "t9")
            XCTAssertEqual(instanceId, "i9")
            XCTAssertEqual(error, "unknown entry")
        } else {
            XCTFail("Round-trip engineRewindResult failed")
        }
    }

    /// Regression: a refused rewind previously produced ZERO feedback on iOS
    /// — the user tapped "Rewind", nothing visibly happened, and there was
    /// no toast, no log, nothing. This pins that a rejection notice now
    /// surfaces an error toast.
    @MainActor
    func testEngineRewindResultShowsErrorToast() {
        let vm = SessionViewModel()
        XCTAssertTrue(vm.toastMessages.isEmpty)

        vm.handleEvent(.engineRewindResult(tabId: "t-rw", instanceId: "i-rw", error: "entry is not a user turn"))

        XCTAssertTrue(vm.toastMessages.contains { $0.style == .error && $0.title == "Rewind not applied" })
    }
}
