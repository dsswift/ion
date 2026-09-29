import XCTest
@testable import IonRemote

/// engine_steer_interrupted_stream: the engine ended a streaming turn early so
/// a steer applies on the next one. The steer's own rows reach the phone on the
/// server's transcript; this event is observed for its log line.
final class NormalizedEventSteerTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

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

    func testDecodeEngineSteerInterruptedStream() throws {
        let json = """
        {"type":"desktop_steer_interrupted_stream","tabId":"t1","steerInterruptBlocksKept":1,"steerQueuedCount":1}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .engineSteerInterruptedStream = event else {
            return XCTFail("Expected engineSteerInterruptedStream, got \(event)")
        }
    }
}
