import XCTest
@testable import IonRemote

/// The Swift catalog equals the shared snapshot the TypeScript catalog is
/// held to, and its validation mirrors `automation-catalog.test.ts`.
final class AutomationCatalogTests: XCTestCase {

    private struct Snapshot: Decodable, Equatable {
        let triggers: [AutomationTriggerSpec]
        let actions: [AutomationActionSpec]
    }

    func testTheSwiftCatalogEqualsTheSharedSnapshot() throws {
        let url = try IntegrationsFixtures.repoFile("packages/shared/src/__tests__/fixtures/automation-catalog.json")
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
        XCTAssertEqual(snapshot.triggers.map(\.event), AutomationCatalog.triggers.map(\.event))
        for (shared, swift) in zip(snapshot.triggers, AutomationCatalog.triggers) {
            XCTAssertEqual(shared, swift, shared.event)
        }
        XCTAssertEqual(snapshot.actions, AutomationCatalog.actions)
    }

    private func definition(_ event: String, condition: AutomationConditionGroup? = nil, steps: [AutomationStep] = [.action(AutomationAction(kind: "record"))]) -> AutomationDefinition {
        AutomationDefinition(id: "user.test", name: "Test", enabled: true, trigger: AutomationTrigger(event: event), condition: condition, steps: steps, actions: nil, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z")
    }

    private func all(_ conditions: AutomationCondition...) -> AutomationConditionGroup {
        AutomationConditionGroup(all: conditions.map(AutomationConditionExpression.condition))
    }

    func testTheRefinementRuleIsValid() {
        let rule = definition("conversation:message-submitted", condition: all(
            AutomationCondition(path: "payload.worktreePath", operator: .exists),
            AutomationCondition(path: "payload.stage", operator: .equals, value: .string("test")),
            AutomationCondition(path: "payload.messageKind", operator: .equals, value: .string("prompt")),
            AutomationCondition(path: "payload.permissionMode", operator: .equals, value: .string("auto"))
        ), steps: [.action(AutomationAction(kind: "worktree:set-stage", payload: ["stage": .string("bug"), "onlyIfStage": .string("test")]))])
        XCTAssertNil(AutomationCatalog.validationError(rule))
    }

    func testRefusalsMatchTheSharedCatalog() {
        let cases: [(String, AutomationDefinition)] = [
            ("Unknown trigger event: git:changed", definition("git:changed")),
            ("\"A message is submitted\" has no field payload.previousStage",
             definition("conversation:message-submitted", condition: all(AutomationCondition(path: "payload.previousStage", operator: .exists)))),
            ("Current worktree stage does not allow shipping",
             definition("conversation:message-submitted", condition: all(AutomationCondition(path: "payload.stage", operator: .equals, value: .string("shipping"))))),
            ("\"Engine status changes\" cannot supply a worktree for Set the worktree stage",
             definition("engine:status", steps: [.action(AutomationAction(kind: "worktree:set-stage", payload: ["stage": .string("bug")]))])),
            ("Show a desktop notification requires Title",
             definition("conversation:message-submitted", steps: [.action(AutomationAction(kind: "desktop:notification", payload: [:]))])),
            ("Worktree cannot use operator equals",
             definition("worktree:created", condition: all(AutomationCondition(path: "payload.worktreePath", operator: .equals, value: .string("/x"))))),
            ("Start an AI conversation needs a directory this trigger cannot supply",
             definition("engine:status", steps: [.action(AutomationAction(kind: "conversation:run", payload: ["prompt": .string("hi")]))])),
        ]
        for (expected, rule) in cases {
            XCTAssertEqual(AutomationCatalog.validationError(rule), expected)
        }
    }

    func testAWorktreeActionFromATriggerThatSuppliesOneIsValid() {
        XCTAssertNil(AutomationCatalog.validationError(definition("worktree:pin-advanced", steps: [
            .action(AutomationAction(kind: "worktree:set-stage", payload: ["stage": .string("test")]))
        ])))
        XCTAssertNil(AutomationCatalog.validationError(definition("engine:status", steps: [
            .action(AutomationAction(kind: "conversation:run", payload: ["prompt": .string("hi"), "directory": .string("/repo")]))
        ])))
    }

    func testEveryTriggerFieldListsAnOperatorAndEveryTemplateIsValid() {
        for trigger in AutomationCatalog.triggers {
            for field in trigger.fields { XCTAssertFalse(field.operators.isEmpty, "\(trigger.event) \(field.path)") }
        }
        for template in AutomationTemplates.all {
            XCTAssertNil(AutomationCatalog.validationError(template.definition()), template.id)
        }
    }
}
