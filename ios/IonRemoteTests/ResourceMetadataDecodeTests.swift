import XCTest
@testable import IonRemote

/// Regression pins for resource metadata decoding.
///
/// THE BUG THIS EXISTS FOR: `metadata` is `map[string]interface{}` on the
/// engine side, so a producer may legitimately send numbers and booleans. The
/// iOS decoder kept only `as? String`, which SILENTLY DROPPED every other
/// scalar — a chart publishing `chartRevision: 3` and `chartSeriesCount: 2`
/// arrived on the phone with neither key present, and nothing anywhere
/// reported a problem. Every assertion below fails on the string-only decoder.
final class ResourceMetadataDecodeTests: XCTestCase {

    private func item(metadata: [String: AnyCodable]) -> ResourceItem {
        ResourceItem(from: [
            "id": AnyCodable("r1"),
            "kind": AnyCodable("chart"),
            "producer": AnyCodable("desktop"),
            "content": AnyCodable("{}"),
            "createdAt": AnyCodable("2026-01-01T00:00:00Z"),
            "metadata": AnyCodable(metadata),
        ])
    }

    func testIntegerMetadataSurvivesDecoding() {
        let decoded = item(metadata: ["chartRevision": AnyCodable(3)])
        XCTAssertEqual(decoded.metadata["chartRevision"], "3")
    }

    func testWholeDoubleDoesNotGainASpuriousDecimal() {
        // A count sent as 3.0 must read as "3", the way the sender meant it.
        let decoded = item(metadata: ["chartSeriesCount": AnyCodable(3.0)])
        XCTAssertEqual(decoded.metadata["chartSeriesCount"], "3")
    }

    func testFractionalDoubleKeepsItsPrecision() {
        let decoded = item(metadata: ["ratio": AnyCodable(1.5)])
        XCTAssertEqual(decoded.metadata["ratio"], "1.5")
    }

    func testBooleanMetadataSurvivesDecoding() {
        let decoded = item(metadata: ["pinned": AnyCodable(true)])
        XCTAssertEqual(decoded.metadata["pinned"], "true")
    }

    func testStringMetadataIsUnchanged() {
        let decoded = item(metadata: ["chartKind": AnyCodable("line")])
        XCTAssertEqual(decoded.metadata["chartKind"], "line")
    }

    /// The whole chart metadata block the desktop publishes, decoded together.
    /// Four of these five keys are numeric and were previously lost.
    func testEveryChartMetadataKeyArrives() {
        let decoded = item(metadata: [
            "chartRevision": AnyCodable(2),
            "chartToolMessageId": AnyCodable("msg-42"),
            "chartKind": AnyCodable("bar"),
            "chartSeriesCount": AnyCodable(3),
            "chartPointCount": AnyCodable(12),
        ])
        XCTAssertEqual(decoded.metadata["chartRevision"], "2")
        XCTAssertEqual(decoded.metadata["chartToolMessageId"], "msg-42")
        XCTAssertEqual(decoded.metadata["chartKind"], "bar")
        XCTAssertEqual(decoded.metadata["chartSeriesCount"], "3")
        XCTAssertEqual(decoded.metadata["chartPointCount"], "12")
    }

    func testAbsentMetadataDecodesToAnEmptyMap() {
        let decoded = ResourceItem(from: [
            "id": AnyCodable("r1"),
            "kind": AnyCodable("briefing"),
        ])
        XCTAssertTrue(decoded.metadata.isEmpty)
    }
}
