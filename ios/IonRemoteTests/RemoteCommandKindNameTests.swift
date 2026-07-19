import XCTest
@testable import IonRemote

/// Pins the bounded-key contract that fixes the key-interpolation memory
/// amplifier: a `.diagnosticLogsResponse` carrying megabytes must never
/// produce a megabyte-scale essential-queue key.
final class RemoteCommandKindNameTests: XCTestCase {

    /// Test 1: essentialKey for diagnosticLogsResponse is the bare kind.
    /// Red on unfixed code: the case previously fell into `default: nil`,
    /// and the send() fallback interpolated the whole payload.
    func testDiagnosticLogsResponseEssentialKeyIsBareKind() {
        let big = String(repeating: "x", count: 1_000_000)
        let cmd = RemoteCommand.diagnosticLogsResponse(logs: big, pairingId: "p", nextSeq: 42)
        XCTAssertEqual(cmd.essentialKey, "diagnosticLogsResponse",
                       "essentialKey must be the bare kind — payload must never leak into the key")
    }

    /// Test 2: kindName for a payload-bearing command with ~1MB payload stays
    /// tiny. Red on unfixed code: `"\(command)"` interpolates the payload
    /// (observed 2,065,388-char key in production).
    func testKindNameBoundedForHugePayload() {
        let big = String(repeating: "y", count: 1_000_000)
        let cmd = RemoteCommand.diagnosticLogsResponse(logs: big, pairingId: "p", nextSeq: 1)
        let name = cmd.kindName
        XCTAssertEqual(name, "diagnosticLogsResponse")
        XCTAssertLessThan(name.count, 100, "kindName must be O(case-name), never O(payload)")

        // Contrast pin: naive interpolation IS unbounded — this is what the
        // fixed fallback key no longer does.
        XCTAssertGreaterThan("unknown:\(cmd)".count, 1_000_000,
                             "sanity: naive interpolation embeds the payload")
    }

    /// kindName works for payload-less cases too (String(describing:) path).
    func testKindNamePayloadlessCases() {
        XCTAssertEqual(RemoteCommand.sync.kindName, "sync")
        XCTAssertEqual(RemoteCommand.unpair.kindName, "unpair")
    }

    /// kindName for other payload-bearing cases returns the case label.
    func testKindNamePayloadBearingCases() {
        XCTAssertEqual(RemoteCommand.cancel(tabId: "t1").kindName, "cancel")
        XCTAssertEqual(RemoteCommand.prompt(tabId: "t1", text: "hi").kindName, "prompt")
        XCTAssertEqual(RemoteCommand.loadConversation(tabId: "t1", before: nil).kindName,
                       "loadConversation")
    }
}
