import XCTest
@testable import IonRemote

/// engine_steer_injected / engine_steer_degraded — mid-turn steer drain
/// confirmation and its idle-fallback sibling. Extracted from
/// NormalizedEventLifecycleTests.swift (file-size cap): the correlation-id
/// coverage added for the iOS rewind-parity fix pushed that file over 600
/// lines, and this section is a self-contained, cohesive concern (one wire
/// event family) that splits cleanly.
final class NormalizedEventSteerTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - engine_steer_injected (mid-turn steer drain confirmation)

    /// Round-trips engine_steer_injected through JSON to lock in CodingKeys.
    /// The Go-side EngineEvent uses json tag "steerMessageLength" (see
    /// engine/internal/types/types.go SteerMessageLength field); the iOS
    /// CodingKeys must match verbatim.
    func testDecodeEngineSteerInjected() throws {
        let json = """
        {
            "type": "desktop_steer_injected",
            "tabId": "t1",
            "instanceId": "i1",
            "steerMessageLength": 42
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineSteerInjected(let tabId, let instanceId, let messageLength, let clientMessageId, let entryId, let kind, let machineAuthored) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(messageLength, 42)
            // All four optional fields are additive (Go omitempty); absent on
            // the wire decodes to nil.
            XCTAssertNil(clientMessageId)
            XCTAssertNil(entryId)
            XCTAssertNil(kind)
            XCTAssertNil(machineAuthored)
        } else {
            XCTFail("Expected engineSteerInjected, got \(event)")
        }
    }

    /// Pins the wire field names the desktop's generic engine-event
    /// forwarder actually sends: the RAW engine field names
    /// (steerClientMessageId / steerEntryId), not a renamed shape — the
    /// forwarder spreads the original EngineEvent payload rather than a
    /// renderer-internal NormalizedEvent. A decoder keyed on any other
    /// name silently drops these fields even though the bytes are present.
    func testDecodeEngineSteerInjectedWithCorrelationIds() throws {
        let json = """
        {
            "type": "desktop_steer_injected",
            "tabId": "t1",
            "instanceId": "i1",
            "steerMessageLength": 42,
            "steerClientMessageId": "msg-abc123",
            "steerEntryId": "9f2a1b7c"
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineSteerInjected(let tabId, let instanceId, let messageLength, let clientMessageId, let entryId, _, _) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(messageLength, 42)
            XCTAssertEqual(clientMessageId, "msg-abc123")
            XCTAssertEqual(entryId, "9f2a1b7c")
        } else {
            XCTFail("Expected engineSteerInjected, got \(event)")
        }
    }

    /// `steerKind`/`steerMachineAuthored` gate whether SessionViewModel's
    /// caller treats this as a genuine client-originated steer vs. a
    /// machine-to-machine injection the user never typed (machineAuthored
    /// == true is suppressed before handleEngineSteerInjected runs).
    func testDecodeEngineSteerInjectedWithKindAndMachineAuthored() throws {
        let json = """
        {
            "type": "desktop_steer_injected",
            "tabId": "t1",
            "instanceId": "i1",
            "steerMessageLength": 42,
            "steerKind": "dispatch_completion",
            "steerMachineAuthored": true
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineSteerInjected(let tabId, let instanceId, let messageLength, _, _, let kind, let machineAuthored) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(messageLength, 42)
            XCTAssertEqual(kind, "dispatch_completion")
            XCTAssertEqual(machineAuthored, true)
        } else {
            XCTFail("Expected engineSteerInjected, got \(event)")
        }
    }

    func testRoundTripEngineSteerInjected() throws {
        let original = RemoteEvent.engineSteerInjected(
            tabId: "t1",
            instanceId: "i1",
            messageLength: 27,
            clientMessageId: nil,
            entryId: nil,
            kind: nil,
            machineAuthored: nil
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineSteerInjected(let tabId, let instanceId, let messageLength, let clientMessageId, let entryId, let kind, let machineAuthored) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(messageLength, 27)
            XCTAssertNil(clientMessageId)
            XCTAssertNil(entryId)
            XCTAssertNil(kind)
            XCTAssertNil(machineAuthored)
        } else {
            XCTFail("Round-trip engineSteerInjected failed")
        }
    }

    /// Round-trips with both correlation ids present — the shape a genuine
    /// client-originated steer carries once the desktop-side fix threads the
    /// sender's own id through as the correlation id (see
    /// send-slice.test.ts's remote-steer-correlation coverage).
    func testRoundTripEngineSteerInjectedWithCorrelationIds() throws {
        let original = RemoteEvent.engineSteerInjected(
            tabId: "t1",
            instanceId: "i1",
            messageLength: 27,
            clientMessageId: "msg-xyz789",
            entryId: "ab12cd34",
            kind: nil,
            machineAuthored: false
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineSteerInjected(let tabId, let instanceId, let messageLength, let clientMessageId, let entryId, _, let machineAuthored) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(messageLength, 27)
            XCTAssertEqual(clientMessageId, "msg-xyz789")
            XCTAssertEqual(entryId, "ab12cd34")
            XCTAssertEqual(machineAuthored, false)
        } else {
            XCTFail("Round-trip engineSteerInjected with correlation ids failed")
        }
    }

    /// CLI tabs receive the event without an instanceId (the runloop
    /// emits steer events at the run level; the instanceId is added by
    /// the desktop's remote bridge for engine tabs).
    func testDecodeEngineSteerInjectedWithoutInstanceId() throws {
        let json = """
        {
            "type": "desktop_steer_injected",
            "tabId": "t1",
            "steerMessageLength": 5
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineSteerInjected(let tabId, let instanceId, let messageLength, let clientMessageId, let entryId, _, _) = event {
            XCTAssertEqual(tabId, "t1")
            XCTAssertNil(instanceId)
            XCTAssertEqual(messageLength, 5)
            XCTAssertNil(clientMessageId)
            XCTAssertNil(entryId)
        } else {
            XCTFail("Expected engineSteerInjected, got \(event)")
        }
    }

    // MARK: - engine_steer_degraded (idle/no-owning-run fallback)

    func testRoundTripEngineSteerDegraded() throws {
        let original = RemoteEvent.engineSteerDegraded(tabId: "t1", instanceId: "i1", messageLength: 27, kind: nil, machineAuthored: nil)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        if case .engineSteerDegraded(let tabId, let instanceId, let messageLength, _, _) = decoded {
            XCTAssertEqual(tabId, "t1")
            XCTAssertEqual(instanceId, "i1")
            XCTAssertEqual(messageLength, 27)
        } else {
            XCTFail("Round-trip engineSteerDegraded failed")
        }
    }

    func testDecodeEngineSteerDegradedDoesNotAliasLiveSteer() throws {
        let json = """
        {"type":"desktop_steer_degraded","tabId":"t1","steerDegradedMessageLength":5}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .engineSteerDegraded(let tabId, let instanceId, let messageLength, _, _) = event else {
            return XCTFail("Expected engineSteerDegraded, got \(event)")
        }
        XCTAssertEqual(tabId, "t1")
        XCTAssertNil(instanceId)
        XCTAssertEqual(messageLength, 5)
    }

    // MARK: - engine_steer_interrupted_stream (mid-stream early stop)

    func testRoundTripEngineSteerInterruptedStream() throws {
        let original = RemoteEvent.engineSteerInterruptedStream(tabId: "t1", instanceId: "i1", blocksKept: 2, queuedSteers: 3)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        guard case .engineSteerInterruptedStream(let tabId, let instanceId, let blocksKept, let queuedSteers) = decoded else {
            return XCTFail("Round-trip engineSteerInterruptedStream failed, got \(decoded)")
        }
        XCTAssertEqual(tabId, "t1")
        XCTAssertEqual(instanceId, "i1")
        XCTAssertEqual(blocksKept, 2)
        XCTAssertEqual(queuedSteers, 3)
    }

    /// Both counts are `omitempty` in Go, so a zero is absent from the wire.
    /// Decoding them as non-optional would throw and drop the whole event —
    /// which would lose the only signal explaining why an assistant message
    /// ended short.
    func testDecodeEngineSteerInterruptedStreamToleratesOmittedCounts() throws {
        let json = """
        {"type":"desktop_steer_interrupted_stream","tabId":"t1"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .engineSteerInterruptedStream(let tabId, let instanceId, let blocksKept, let queuedSteers) = event else {
            return XCTFail("Expected engineSteerInterruptedStream, got \(event)")
        }
        XCTAssertEqual(tabId, "t1")
        XCTAssertNil(instanceId)
        XCTAssertNil(blocksKept)
        XCTAssertNil(queuedSteers)
    }

    /// The interrupt notice must not be mistaken for a delivery: it reports the
    /// scheduling decision, while `desktop_steer_injected` reports the steer
    /// reaching the conversation. A client that conflated them would render the
    /// divider twice, or render it before the steer actually landed.
    func testDecodeEngineSteerInterruptedStreamIsDistinctFromInjected() throws {
        let json = """
        {"type":"desktop_steer_interrupted_stream","tabId":"t1","steerInterruptBlocksKept":1,"steerQueuedCount":1}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        if case .engineSteerInjected = event {
            XCTFail("interrupt notice decoded as a steer injection")
        }
        guard case .engineSteerInterruptedStream = event else {
            return XCTFail("Expected engineSteerInterruptedStream, got \(event)")
        }
    }
}
