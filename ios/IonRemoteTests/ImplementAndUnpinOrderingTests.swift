import XCTest
@testable import IonRemote

/// Pins the ordering contract for the "Implement and Unpin" button:
/// the toggleTabGroupPin wire command MUST be sent before implement_plan
/// on the wire.
///
/// Root cause of the bug: the old `implementAndUnpin` in PlanApprovalCardView
/// called `viewModel.toggleTabGroupPin(tabId:)` then `implement(...)`, where
/// each helper fired an independent `Task { transport.send(...) }`. Two
/// independent Tasks have no ordering guarantee; the implement command could
/// arrive at the desktop while the tab was still pinned, causing the
/// desktop-side auto-move guard (`!tab.groupPinned` in implement-plan.ts) to
/// suppress auto-grouping.
///
/// Fix: `sendUnpinThenImplementPlanIntent` in SessionViewModel+ImplementPlan.swift
/// chains both sends in a SINGLE `Task` with sequential `try await` calls, so
/// toggleTabGroupPin is guaranteed to complete before implementPlan is sent.
/// `implementAndUnpin` in PlanApprovalCardView now calls ONLY this one method.
///
/// These tests are structural (source-level) following the pattern established
/// by UnifiedSubmitPathTests.swift. They pin the implementation contract at the
/// declaration site — a live transport mock is not possible here because
/// TransportManager is a concrete final class with no injectable protocol.
///
/// **Failure mode of the old code:**
///   - `implementAndUnpin` called `toggleTabGroupPin` (fires Task A) then
///     `implement` → `sendImplementPlanIntent` (fires Task B). No ordering
///     between A and B.
///   - These tests would fail because the source still contained the two
///     separate independent calls.
final class ImplementAndUnpinOrderingTests: XCTestCase {

    // MARK: - Source loaders

    private func implementPlanSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/ViewModels/SessionViewModel+ImplementPlan.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func cardViewSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/PlanApprovalCardView.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - Single-Task ordering in the ViewModel

    /// The new method must exist and use a single Task containing BOTH wire
    /// sends, not two separate Tasks.
    func testSendUnpinThenImplementPlanIntent_exists() throws {
        let src = try implementPlanSource()
        XCTAssertTrue(
            src.contains("func sendUnpinThenImplementPlanIntent("),
            "sendUnpinThenImplementPlanIntent must be declared in SessionViewModel+ImplementPlan.swift"
        )
    }

    /// Within `sendUnpinThenImplementPlanIntent`, the toggleTabGroupPin send
    /// must appear BEFORE the implementPlan send in the source — this is the
    /// structural ordering contract.
    func testToggleTabGroupPin_appearsBeforeImplementPlan_inOrderedMethod() throws {
        let src = try implementPlanSource()

        // Isolate the method body (everything after the func declaration)
        guard let methodStart = src.range(of: "func sendUnpinThenImplementPlanIntent(") else {
            XCTFail("sendUnpinThenImplementPlanIntent not found in source")
            return
        }
        let methodBody = String(src[methodStart.lowerBound...])

        let toggleRange = methodBody.range(of: "transport.send(.toggleTabGroupPin(")
        let implementRange = methodBody.range(of: "transport.send(.implementPlan(")

        XCTAssertNotNil(toggleRange,
            "toggleTabGroupPin send must appear inside sendUnpinThenImplementPlanIntent")
        XCTAssertNotNil(implementRange,
            "implementPlan send must appear inside sendUnpinThenImplementPlanIntent")

        if let toggleR = toggleRange, let implementR = implementRange {
            XCTAssertLessThan(
                toggleR.lowerBound,
                implementR.lowerBound,
                "toggleTabGroupPin send must appear BEFORE implementPlan send — ordering contract"
            )
        }
    }

    /// The single Task block must contain both sends — not two separate Tasks.
    /// Old code: Task { send(.toggleTabGroupPin) } ... Task { send(.implementPlan) }
    /// New code: Task { await send(.toggle) ; await send(.implement) }
    func testBothSendsSitInSingleTask_notSeparateTasks() throws {
        let src = try implementPlanSource()

        // Count the number of `Task {` blocks that appear inside
        // sendUnpinThenImplementPlanIntent. There must be exactly one transport
        // Task (the ordering Task) plus at most one guard-path Task (no-transport
        // toast). Two transport Tasks would mean the ordering guarantee is gone.
        guard let methodStart = src.range(of: "func sendUnpinThenImplementPlanIntent(") else {
            XCTFail("sendUnpinThenImplementPlanIntent not found")
            return
        }
        // Find the end of this method by locating the next top-level `func `
        // declaration after the method start (or end of extension).
        let tail = String(src[methodStart.lowerBound...])
        // Split on "func " to isolate just this method's body. The first
        // segment is the method; the rest is later code.
        let segments = tail.components(separatedBy: "\n    func ")
        let methodBodyOnly = segments[0]

        // Count bare `transport.send(` occurrences — there must be exactly 2
        // (one for toggleTabGroupPin, one for implementPlan) and they must
        // both be inside a single Task block (not two separate ones).
        let transportSendCount = methodBodyOnly
            .components(separatedBy: "transport.send(")
            .count - 1
        XCTAssertEqual(transportSendCount, 2,
            "sendUnpinThenImplementPlanIntent must call transport.send exactly twice (toggle + implement)")

        // There must be exactly one `Task {` in the transport path.
        // The guard no-transport path uses `Task { @MainActor` — that's allowed.
        // Count plain `Task { [weak self]` (the transport Task) occurrences.
        let transportTaskCount = methodBodyOnly
            .components(separatedBy: "Task { [weak self]")
            .count - 1
        XCTAssertEqual(transportTaskCount, 1,
            "Both transport.send calls must live inside a SINGLE Task block — not two separate Tasks")
    }

    // MARK: - Call site in PlanApprovalCardView

    /// The old `implementAndUnpin` called `toggleTabGroupPin` and `implement`
    /// separately. This pins that the old pattern is gone from the view.
    func testImplementAndUnpin_doesNotCallToggleTabGroupPinDirectly() throws {
        let src = try cardViewSource()

        // Isolate the implementAndUnpin method body.
        guard let methodStart = src.range(of: "private func implementAndUnpin(") else {
            XCTFail("implementAndUnpin not found in PlanApprovalCardView.swift")
            return
        }
        let tail = String(src[methodStart.lowerBound...])
        let segments = tail.components(separatedBy: "\n    private func ")
        let methodBody = segments[0]

        XCTAssertFalse(
            methodBody.contains("toggleTabGroupPin("),
            "implementAndUnpin must NOT call toggleTabGroupPin directly — it must delegate to sendUnpinThenImplementPlanIntent"
        )
        XCTAssertFalse(
            methodBody.contains("sendImplementPlanIntent("),
            "implementAndUnpin must NOT call sendImplementPlanIntent directly — it must delegate to sendUnpinThenImplementPlanIntent"
        )
    }

    /// The view's `implementAndUnpin` must delegate to the ordered ViewModel method.
    func testImplementAndUnpin_callsSendUnpinThenImplementPlanIntent() throws {
        let src = try cardViewSource()

        guard let methodStart = src.range(of: "private func implementAndUnpin(") else {
            XCTFail("implementAndUnpin not found")
            return
        }
        let tail = String(src[methodStart.lowerBound...])
        let segments = tail.components(separatedBy: "\n    private func ")
        let methodBody = segments[0]

        XCTAssertTrue(
            methodBody.contains("sendUnpinThenImplementPlanIntent("),
            "implementAndUnpin must call sendUnpinThenImplementPlanIntent to guarantee wire ordering"
        )
    }
}
