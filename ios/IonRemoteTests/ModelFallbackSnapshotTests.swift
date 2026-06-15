import XCTest
@testable import IonRemote

/// Pins the wire shape and decode behaviour for the per-engine-instance
/// model-fallback indicator.
///
/// The engine emits ModelFallbackEvent when a child run's requested model
/// doesn't resolve to a provider. The desktop projects that fact onto
/// `RemoteTabState.conversationInstances[i].modelFallback` via the snapshot,
/// rather than as a live RemoteEvent variant — the engine's event is a
/// workflow signal, and projecting through the snapshot gives iOS a
/// sticky-across-reconnect indicator without a new wire variant. See
/// CLAUDE.md § "Common parity surfaces" row for model fallback indicator
/// and § "The typed-event corollary" for the broader rule that the
/// engine's typed event is the complete signaling surface; how each
/// consumer renders it is the consumer's policy, not engine policy.
///
/// This test pins:
///   1. Decoding a snapshot with `modelFallback` populates the
///      `EngineInstanceInfo.modelFallback` Swift field.
///   2. Decoding a snapshot without `modelFallback` leaves the field nil
///      — so when the desktop omits it on a subsequent snapshot (which
///      it does on the idle transition), iOS clears the indicator.
///   3. The fallback struct round-trips through JSONEncoder/Decoder
///      cleanly — the wire format is stable.
final class ModelFallbackSnapshotTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// Minimal RemoteTabState JSON with one engine instance carrying a
    /// modelFallback block. Mirrors what the desktop's snapshot.ts emits
    /// when the engine_model_fallback event has been observed for the
    /// run currently associated with this instance.
    private func sampleTabWithFallback(requestedModel: String, fallbackModel: String) -> String {
        """
        {"id":"t1","title":"Tab","customTitle":null,"status":"running","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null,"isEngine":true,"engineInstances":[{"id":"inst1","label":"Main","modelFallback":{"requestedModel":"\(requestedModel)","fallbackModel":"\(fallbackModel)"}}],"activeEngineInstanceId":"inst1"}
        """
    }

    func testDecodeSnapshotWithModelFallback() throws {
        let json = """
        {"type":"snapshot","tabs":[\(sampleTabWithFallback(requestedModel: "standard", fallbackModel: "claude-sonnet-4-6"))]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _) = event else {
            XCTFail("Expected snapshot, got \(event)")
            return
        }
        XCTAssertEqual(tabs.count, 1)
        let instances = tabs[0].engineInstances ?? []
        XCTAssertEqual(instances.count, 1, "expected one engine instance")
        let inst = instances[0]
        XCTAssertNotNil(inst.modelFallback, "modelFallback should decode from the snapshot payload")
        XCTAssertEqual(inst.modelFallback?.requestedModel, "standard")
        XCTAssertEqual(inst.modelFallback?.fallbackModel, "claude-sonnet-4-6")
    }

    func testDecodeSnapshotWithoutModelFallback() throws {
        // No modelFallback field on the engineInstances entry — the
        // desktop omits it on snapshots after the run goes idle (the
        // engine-event-status idle branch clears the source map). iOS
        // must decode that as nil so the ⚠ glyph disappears.
        let json = """
        {"type":"snapshot","tabs":[{"id":"t1","title":"Tab","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null,"isEngine":true,"engineInstances":[{"id":"inst1","label":"Main"}],"activeEngineInstanceId":"inst1"}]}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .snapshot(let tabs, _, _, _, _, _, _, _, _, _, _) = event else {
            XCTFail("Expected snapshot, got \(event)")
            return
        }
        let instances = tabs[0].engineInstances ?? []
        XCTAssertEqual(instances.count, 1)
        XCTAssertNil(instances[0].modelFallback, "modelFallback should be nil when the field is absent from the wire payload")
    }

    func testModelFallbackStructRoundTrips() throws {
        // Encode → decode round-trip pins the wire format. If a future
        // change renames a field or adds a required one, this test
        // catches the drift before it ships.
        let original = EngineInstanceModelFallback(
            requestedModel: "standard",
            fallbackModel: "claude-sonnet-4-6"
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(EngineInstanceModelFallback.self, from: data)
        XCTAssertEqual(decoded, original)
    }
}
