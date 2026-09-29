import XCTest
@testable import IonRemote

/// The editor's draft rules and plain-language text, ported from
/// `automation-draft.ts`, `automation-editor-helpers.ts`, and `automation-describe.ts`.
final class AutomationDraftTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_767_225_600) // 2026-01-01T00:00:00Z

    private func trigger(_ event: String) -> AutomationTriggerSpec {
        guard let trigger = AutomationCatalog.trigger(event) else { fatalError("no trigger \(event)") }
        return trigger
    }

    func testNewConditionsAndActionsStartValid() {
        XCTAssertEqual(AutomationDraft.defaultCondition(trigger("conversation:message-submitted")),
                       AutomationCondition(path: "payload.messageKind", operator: .equals, value: .string("prompt")))
        XCTAssertEqual(AutomationDraft.defaultCondition(trigger("worktree:created")),
                       AutomationCondition(path: "payload.worktreePath", operator: .exists))
        XCTAssertEqual(AutomationDraft.defaultAction("worktree:set-stage"), AutomationAction(kind: "worktree:set-stage", payload: ["stage": .string("plan")]))
        XCTAssertEqual(AutomationDraft.defaultAction("desktop:notification"), AutomationAction(kind: "desktop:notification", payload: ["title": .string("")]))
        XCTAssertEqual(AutomationDraft.defaultAction("record"), AutomationAction(kind: "record", payload: nil))
        let steer = trigger("conversation:message-submitted").field("payload.isSteer")!
        XCTAssertEqual(AutomationDraft.condition(forField: steer), AutomationCondition(path: "payload.isSteer", operator: .equals, value: .bool(false)))
    }

    func testOnlyTheFlatAllFormIsEditable() {
        let flat = AutomationConditionGroup(all: [.condition(AutomationCondition(path: "payload.stage", operator: .exists))])
        XCTAssertEqual(AutomationDraft.flatConditions(nil), [])
        XCTAssertEqual(AutomationDraft.flatConditions(flat)?.count, 1)
        XCTAssertNil(AutomationDraft.flatConditions(AutomationConditionGroup(all: nil, any: [.condition(AutomationCondition(path: "p", operator: .exists))])))
        XCTAssertNil(AutomationDraft.flatConditions(AutomationConditionGroup(all: [.group(flat)])))
    }

    func testChangingTheEventDropsWhatItCannotCarryAndKeepsBranches() throws {
        let rule = try IntegrationsFixtures.json(IntegrationsFixtures.userRule).decoded(as: AutomationDefinition.self)
        let moved = AutomationDraft.settingEvent("engine:status", on: rule)
        XCTAssertEqual(moved.trigger.event, "engine:status")
        XCTAssertNil(moved.condition, "engine:status has no stage field")
        XCTAssertEqual(AutomationDraft.plainActions(moved.steps ?? []), [], "engine:status cannot supply a worktree")
        XCTAssertEqual(AutomationDraft.branchSteps(moved.steps ?? []).count, 1)
    }

    func testFinalizeFillsIdNameAndStepsOnly() {
        var draft = AutomationDraft.blank(now: now)
        draft.trigger = AutomationTrigger(event: " worktree:created ")
        draft.actions = [AutomationAction(kind: "record")]
        draft.steps = nil
        let final = AutomationDraft.finalize(draft, now: now) { "abc" }
        XCTAssertEqual(final.id, "user.abc")
        XCTAssertEqual(final.name, "Untitled automation")
        XCTAssertEqual(final.trigger.event, "worktree:created")
        XCTAssertEqual(final.steps, [.action(AutomationAction(kind: "record"))])
        XCTAssertNil(final.actions)
        XCTAssertEqual(final.updatedAt, "2026-01-01T00:00:00.000Z")
    }

    func testTheSavedFormEncodesTheWireShape() throws {
        let rule = try IntegrationsFixtures.json(IntegrationsFixtures.userRule).decoded(as: AutomationDefinition.self)
        XCTAssertEqual(try JSONValue.encoding(rule), IntegrationsFixtures.json(IntegrationsFixtures.userRule))
    }

    func testPreviewReadsTheRule() {
        let refinement = AutomationTemplates.all[0].definition(now: now) { "x" }
        XCTAssertEqual(AutomationDescribe.preview(refinement),
                       "When a message is submitted, if Worktree is present and Current worktree stage equals Needs testing and Message kind equals Operator prompt and Permission mode equals Auto mode then set the stage to bug.")
        var nothing = AutomationDraft.blank(now: now)
        nothing.trigger = AutomationTrigger(event: "worktree:landed")
        XCTAssertEqual(AutomationDescribe.preview(nothing), "When a worktree lands, then do nothing.")
        XCTAssertEqual(AutomationDescribe.actionSummary([]), "No actions configured.")
        XCTAssertEqual(AutomationDescribe.actionSummary([.action(AutomationAction(kind: "record")), .action(AutomationAction(kind: "custom:x"))]), "Record this run only, custom:x")
    }

    func testTraceRowsDescribeEachDecision() throws {
        let runs = try IntegrationsFixtures.json(IntegrationsFixtures.history).decoded(as: [AutomationHistoryEntry].self)
        XCTAssertNil(runs[1].trace)
        XCTAssertEqual(AutomationDescribe.traceRows(try XCTUnwrap(runs[0].trace)), [
            "Trigger received: A worktree update reaches the bench",
            "Conditions: Matched: payload.stage equals bug (matched)",
            "Causation: Allowed to run.",
            "Action failed: Set the worktree stage (stage refused)",
            "Branch selected: Else actions (Did not match: payload.branchName (was no value))",
        ])
    }

    func testTemplatesGetASluggedUserId() {
        let definition = AutomationTemplates.all.first { $0.id == "align-merge" }!.definition(now: now) { "id1" }
        XCTAssertEqual(definition.id, "user.align-enters-merge-checks.id1")
        XCTAssertEqual(AutomationTemplates.slug("  Hello, World!  "), "hello-world")
        XCTAssertEqual(AutomationTemplates.all.first { $0.id == "bug-migration" }!.definition(now: now).condition, nil)
    }
}
