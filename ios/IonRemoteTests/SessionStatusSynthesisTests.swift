import XCTest
@testable import IonRemote

/// Phase 4 regression tests for the SessionStatus → StatusFields
/// synthesis helper. The helper is the chokepoint that lets every
/// existing iOS read site continue to function unchanged while the
/// engine emits the new typed engine_session_status event.
///
/// If a future change shifts a field mapping or drops a value, the
/// failure surfaces here rather than as a runtime regression on the
/// instance bar / status caption / model indicator surfaces.
final class SessionStatusSynthesisTests: XCTestCase {

    /// Helper that constructs a SessionStatus with sensible defaults
    /// so tests can override only the fields they care about.
    private func makeStatus(
        key: String = "tab-1:inst-1",
        state: String = "running",
        sessionId: String? = nil,
        model: String? = nil,
        contextPercent: Int? = nil,
        contextWindow: Int? = nil,
        totalCostUsd: Double? = nil,
        permissionDenialsPending: [PermissionDenialEntry]? = nil,
        extensionName: String? = nil,
        backgroundAgentCount: Int? = nil,
        hasInflightRun: Bool? = nil,
        lastEmittedAt: Int64 = 1_780_000_000_000
    ) -> SessionStatus {
        return SessionStatus(
            key: key,
            state: state,
            stateSince: nil,
            lastEmittedAt: lastEmittedAt,
            hasInflightRun: hasInflightRun,
            backgroundAgentCount: backgroundAgentCount,
            permissionDenialsPending: permissionDenialsPending,
            model: model,
            contextPercent: contextPercent,
            contextWindow: contextWindow,
            totalCostUsd: totalCostUsd,
            sessionId: sessionId,
            extensionName: extensionName
        )
    }

    func testRunningStatePreservedVerbatim() {
        let s = makeStatus(state: "running")
        let f = SessionStatusSynthesis.toStatusFields(tabId: "tab-1", status: s)
        XCTAssertEqual(f.state, "running")
    }

    func testIdleStatePreservedVerbatim() {
        let s = makeStatus(state: "idle")
        let f = SessionStatusSynthesis.toStatusFields(tabId: "tab-1", status: s)
        XCTAssertEqual(f.state, "idle")
    }

    func testLabelDefaultsToTabId() {
        // StatusFields.label is non-optional and used by the
        // EngineInstanceBar caption when the engine hasn't yet
        // broadcast an extensionName. The synthesis fills it from
        // the tabId so the bar isn't empty on the first emission.
        let s = makeStatus()
        let f = SessionStatusSynthesis.toStatusFields(tabId: "ion-development", status: s)
        XCTAssertEqual(f.label, "ion-development")
    }

    func testSessionIdMapped() {
        let s = makeStatus(sessionId: "conv-abc-123")
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.sessionId, "conv-abc-123")
    }

    func testNilSessionIdPreservedAsNil() {
        let s = makeStatus(sessionId: nil)
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertNil(f.sessionId)
    }

    func testNilModelMapsToEmptyString() {
        // StatusFields.model is non-optional in the legacy type so
        // the synthesis must default nil to "" rather than crash.
        let s = makeStatus(model: nil)
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.model, "")
    }

    func testValidModelPreserved() {
        let s = makeStatus(model: "claude-4")
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.model, "claude-4")
    }

    func testContextPercentCastFromIntToDouble() {
        let s = makeStatus(contextPercent: 42)
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.contextPercent, 42.0)
    }

    func testNilContextPercentDefaultsToZero() {
        let s = makeStatus(contextPercent: nil)
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.contextPercent, 0.0)
    }

    func testContextWindowMapped() {
        let s = makeStatus(contextWindow: 200_000)
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.contextWindow, 200_000)
    }

    func testTotalCostUsdPreservedIncludingNil() {
        let s1 = makeStatus(totalCostUsd: 1.23)
        XCTAssertEqual(SessionStatusSynthesis.toStatusFields(tabId: "t", status: s1).totalCostUsd, 1.23)

        let s2 = makeStatus(totalCostUsd: nil)
        XCTAssertNil(SessionStatusSynthesis.toStatusFields(tabId: "t", status: s2).totalCostUsd)
    }

    func testPermissionDenialsMappedFromPending() {
        let denial = PermissionDenialEntry(toolName: "AskUserQuestion", toolUseId: "tu-1", toolInput: nil)
        let s = makeStatus(permissionDenialsPending: [denial])
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.permissionDenials?.count, 1)
        XCTAssertEqual(f.permissionDenials?.first?.toolName, "AskUserQuestion")
    }

    func testExtensionNamePreservedWhenSet() {
        let s = makeStatus(extensionName: "Chief of Staff")
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.extensionName, "Chief of Staff")
    }

    func testBackgroundAgentCountMappedToBackgroundAgents() {
        let s = makeStatus(backgroundAgentCount: 3)
        let f = SessionStatusSynthesis.toStatusFields(tabId: "t", status: s)
        XCTAssertEqual(f.backgroundAgents, 3)
    }

    func testRoundTripAllFieldsTogether() {
        // End-to-end synthesis with every field populated, to catch
        // any field that gets dropped by a mechanical refactor.
        let denial = PermissionDenialEntry(toolName: "ExitPlanMode", toolUseId: "tu-9", toolInput: nil)
        let s = makeStatus(
            key: "ion-ops:inst-2",
            state: "idle",
            sessionId: "conv-xyz",
            model: "claude-4",
            contextPercent: 78,
            contextWindow: 200_000,
            totalCostUsd: 4.56,
            permissionDenialsPending: [denial],
            extensionName: "Ion Operations",
            backgroundAgentCount: 1
        )
        let f = SessionStatusSynthesis.toStatusFields(tabId: "ion-ops", status: s)

        XCTAssertEqual(f.label, "ion-ops")
        XCTAssertEqual(f.state, "idle")
        XCTAssertEqual(f.sessionId, "conv-xyz")
        XCTAssertEqual(f.model, "claude-4")
        XCTAssertEqual(f.contextPercent, 78.0)
        XCTAssertEqual(f.contextWindow, 200_000)
        XCTAssertEqual(f.totalCostUsd, 4.56)
        XCTAssertEqual(f.permissionDenials?.count, 1)
        XCTAssertEqual(f.permissionDenials?.first?.toolName, "ExitPlanMode")
        XCTAssertEqual(f.extensionName, "Ion Operations")
        XCTAssertEqual(f.backgroundAgents, 1)
    }
}
