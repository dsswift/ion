import XCTest
@testable import IonRemote

/// Pins the created-vs-updated plan-divider behavior and the planFilePath
/// carry-through on iOS (mirrors the desktop event-slice-plan-mode behavior).
///
/// The engine emits engine_plan_mode_changed{enabled:true} both when a plan is
/// first created and again when a subsequent turn writes the SAME plan. The
/// FIRST divider for a given planFilePath is "Plan created"; a SUBSEQUENT
/// divider for the same path is "Plan updated". Both carry planFilePath so the
/// divider's slug can be made a tappable link that opens the plan preview.
///
/// Regression contract: if handleEnginePlanModeChanged stops scanning for a
/// prior same-path divider (always emits "Plan created") the second-call
/// assertion goes red; if it drops planFilePath from the Message, the
/// planFilePath assertions go red.
@MainActor
final class PlanDividerCreatedUpdatedTests: XCTestCase {

    private func lastSystemDivider(_ vm: SessionViewModel, _ tabId: String) -> Message? {
        vm.conversationInstances[tabId]?.first?.messages.last { $0.role == .system }
    }

    func testFirstEmitIsPlanCreatedWithPath() {
        let vm = SessionViewModel()
        vm.handleEnginePlanFileWritten(
            tabId: "t1",
            instanceId: nil,
            operation: "created",
            planFilePath: "/tmp/happy-rabbit.md",
            planSlug: "happy-rabbit"
        )
        let divider = lastSystemDivider(vm, "t1")
        XCTAssertNotNil(divider)
        XCTAssertTrue(divider!.content.hasPrefix("── Plan created at "), "created op must render 'Plan created'")
        XCTAssertTrue(divider!.content.contains("happy-rabbit"), "slug must appear")
        XCTAssertEqual(divider!.planFilePath, "/tmp/happy-rabbit.md", "divider must carry planFilePath for the link")
    }

    func testUpdatedOperationIsPlanUpdatedWithPath() {
        let vm = SessionViewModel()
        // First write: created.
        vm.handleEnginePlanFileWritten(
            tabId: "t1", instanceId: nil, operation: "created",
            planFilePath: "/tmp/happy-rabbit.md", planSlug: "happy-rabbit"
        )
        // Second write of the SAME plan: engine reports operation=updated.
        vm.handleEnginePlanFileWritten(
            tabId: "t1", instanceId: nil, operation: "updated",
            planFilePath: "/tmp/happy-rabbit.md", planSlug: "happy-rabbit"
        )
        let msgs = vm.conversationInstances["t1"]?.first?.messages ?? []
        let dividers = msgs.filter { $0.role == .system }
        XCTAssertEqual(dividers.count, 2, "both writes produce a divider")
        XCTAssertTrue(dividers[0].content.hasPrefix("── Plan created at "))
        XCTAssertTrue(dividers[1].content.hasPrefix("── Plan updated at "), "updated op must render 'Plan updated'")
        XCTAssertTrue(dividers[1].content.contains("happy-rabbit"))
        XCTAssertEqual(dividers[1].planFilePath, "/tmp/happy-rabbit.md", "updated divider must carry planFilePath too")
    }

    func testUnknownOperationDefaultsToCreated() {
        let vm = SessionViewModel()
        vm.handleEnginePlanFileWritten(
            tabId: "t1", instanceId: nil, operation: "",
            planFilePath: "/tmp/plan.md", planSlug: "plan"
        )
        let divider = lastSystemDivider(vm, "t1")
        XCTAssertTrue(divider!.content.hasPrefix("── Plan created at "))
    }

    func testPlanModeChangedDoesNotInsertDivider() {
        let vm = SessionViewModel()
        // Plan-mode ENTRY no longer draws a divider — the write event does.
        vm.handleEnginePlanModeChanged(
            tabId: "t1", instanceId: nil, planModeEnabled: true,
            planFilePath: "/tmp/plan.md", planSlug: "plan"
        )
        XCTAssertNil(lastSystemDivider(vm, "t1"), "plan-mode entry must not insert a divider")
    }

    // MARK: - PlanDividerLabel link parsing

    func testPlanDividerLabelLinksSlugWhenPathPresent() {
        var msg = Message(id: "d1", role: .system, content: "── Plan updated at 3:42 PM · happy-rabbit ──", timestamp: 0)
        msg.planFilePath = "/tmp/happy-rabbit.md"
        // The label is linkable: prefix + slug + suffix split on " · ".
        let label = PlanDividerLabel(message: msg, onTapPlan: { _ in })
        XCTAssertNotNil(label.testLinkPath, "a Plan updated divider with a path + handler must be linkable")
        XCTAssertEqual(label.testLinkPath, "/tmp/happy-rabbit.md")
        XCTAssertEqual(label.testLinkSlug, "happy-rabbit")
    }

    func testPlanDividerLabelLinksImplementationSlugWhenPathPresent() {
        var msg = Message(id: "d2", role: .system, content: "── Implementing plan at 3:42 PM · happy-rabbit ──", timestamp: 0)
        msg.planFilePath = "/tmp/happy-rabbit.md"
        let label = PlanDividerLabel(message: msg, onTapPlan: { _ in })
        XCTAssertEqual(label.testLinkPath, "/tmp/happy-rabbit.md")
        XCTAssertEqual(label.testLinkSlug, "happy-rabbit")
    }

    func testPlanDividerLabelNotLinkableWithoutPath() {
        let msg = Message(id: "d3", role: .system, content: "── Plan created at 3:42 PM · x ──", timestamp: 0)
        let label = PlanDividerLabel(message: msg, onTapPlan: { _ in })
        XCTAssertNil(label.testLinkPath, "no planFilePath → not linkable")
    }

    func testPlanDividerLabelNotLinkableForOtherDivider() {
        var msg = Message(id: "d4", role: .system, content: "── Session started at 3:42 PM ──", timestamp: 0)
        msg.planFilePath = "/tmp/x.md"
        let label = PlanDividerLabel(message: msg, onTapPlan: { _ in })
        XCTAssertNil(label.testLinkPath, "session-start divider is not a plan divider → not linkable")
    }
}
