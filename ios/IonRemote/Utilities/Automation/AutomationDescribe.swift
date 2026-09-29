import Foundation

/// Plain-language text for automations: the editor's one-line preview, the
/// list's source and action summaries, and a run's trace. A copy of
/// `desktop/src/renderer/components/settings/pages/integrations/automation-describe.ts`.
enum AutomationDescribe {

    static func operatorLabel(_ op: AutomationConditionOperator) -> String {
        switch op {
        case .equals: return "is"
        case .notEquals: return "is not"
        case .exists: return "is present"
        case .notExists: return "is absent"
        case .contains: return "contains"
        case .notContains: return "does not contain"
        case .matches: return "matches pattern"
        case .greaterThan: return "is greater than"
        case .greaterThanOrEquals: return "is at least"
        case .lessThan: return "is less than"
        case .lessThanOrEquals: return "is at most"
        }
    }

    static func triggerLabel(_ event: String) -> String {
        AutomationCatalog.trigger(event)?.label ?? event
    }

    static func actionLabel(_ kind: String) -> String {
        AutomationCatalog.action(kind)?.label ?? kind
    }

    static func sourceLabel(_ source: AutomationSource) -> String {
        switch source {
        case .user: return "You"
        case .project: return "Project"
        case .enterprise: return "Enterprise"
        case .builtIn: return "Built-in"
        }
    }

    static func actionSummary(_ steps: [AutomationStep]) -> String {
        if steps.isEmpty { return "No actions configured." }
        return steps.map { step in
            switch step {
            case .branch: return "choose a branch"
            case .action(let action): return actionLabel(action.kind)
            }
        }.joined(separator: ", ")
    }

    /// Plain-language summary of a runnable rule.
    static func preview(_ definition: AutomationDefinition) -> String {
        let trigger = AutomationCatalog.trigger(definition.trigger.event)
        let when = trigger?.label ?? definition.trigger.event
        let conditions = AutomationDraft.flatConditions(definition.condition) ?? []
        let ifPart = conditions.isEmpty ? "" : " if " + conditions.map { describeCondition(trigger, $0) }.joined(separator: " and ")
        let steps = AutomationDraft.steps(definition)
        let actions = AutomationDraft.plainActions(steps)
        let thenPart: String
        if !actions.isEmpty {
            thenPart = " then " + actions.map(describeAction).joined(separator: ", ")
        } else {
            thenPart = AutomationDraft.hasBranchSteps(steps) ? " then run its conditional branches" : " then do nothing"
        }
        return "When \(when.lowercased()),\(ifPart)\(thenPart)."
    }

    private static func describeCondition(_ trigger: AutomationTriggerSpec?, _ condition: AutomationCondition) -> String {
        let field = trigger?.field(condition.path)
        let label = field?.label ?? condition.path
        if condition.operator == .exists { return "\(label) is present" }
        if condition.operator == .notExists { return "\(label) is absent" }
        let choice = field?.values?.first { .string($0.value) == condition.value }?.label
        return "\(label) \(condition.operator.rawValue) \(choice ?? plainValue(condition.value))"
    }

    private static func describeAction(_ action: AutomationAction) -> String {
        switch action.kind {
        case "worktree:set-stage": return "set the stage to \(plainValue(action.payload?["stage"] ?? .string("")))"
        case "desktop:notification": return "show a notification"
        case "conversation:slash": return "run /\(plainValue(action.payload?["command"] ?? .string("")))"
        case "conversation:run": return "start a conversation"
        default: return action.kind
        }
    }

    // MARK: Trace

    /// The stored evaluation path of one run, one line per decision.
    static func traceRows(_ trace: AutomationEvaluationTrace) -> [String] {
        [
            "Trigger received: \(triggerLabel(trace.trigger.eventType))",
            "Conditions: \(describeDecision(trace.condition))",
            "Causation: \(describeCausation(trace.causation.decision))",
        ] + trace.steps.flatMap(describeStep)
    }

    private static func describeStep(_ step: AutomationStepDecision) -> [String] {
        switch step {
        case let .action(kind, outcome, error):
            return ["Action \(outcome): \(actionLabel(kind))\(error.map { " (\($0))" } ?? "")"]
        case let .branch(condition, selected, steps):
            return ["Branch selected: \(selected == "then" ? "Then actions" : "Else actions") (\(describeDecisionTree(condition)))"]
                + steps.flatMap(describeStep)
        }
    }

    private static func describeDecision(_ decision: AutomationConditionDecision) -> String {
        if case .none = decision { return "No conditions configured; workflow is eligible." }
        return describeDecisionTree(decision)
    }

    private static func describeDecisionTree(_ decision: AutomationConditionDecision) -> String {
        switch decision {
        case let .group(all, any, matched):
            let parts = (all + any).map(describeDecisionTree)
            return "\(matched ? "Matched" : "Did not match")\(parts.isEmpty ? "" : ": " + parts.joined(separator: "; "))"
        case let .condition(path, op, expected, actual, matched):
            let expectedPart = expected.map { " \(op) \(formatValue($0))" } ?? ""
            return "\(path)\(expectedPart) (\(matched ? "matched" : "was \(formatValue(actual))"))"
        case .none:
            return "No conditions configured; workflow is eligible."
        }
    }

    private static func describeCausation(_ decision: String) -> String {
        switch decision {
        case "continued": return "Allowed to run."
        case "cycle": return "Skipped to prevent an automation cycle."
        case "max-depth": return "Skipped because the automation chain reached its depth limit."
        default: return "Not evaluated after the condition did not match."
        }
    }

    // MARK: Values

    /// A value as the trace shows it: text as itself, anything else as JSON.
    static func formatValue(_ value: JSONValue?) -> String {
        guard let value else { return "no value" }
        if case .string(let text) = value { return text }
        return json(value)
    }

    /// A value as a sentence shows it: text, a number, yes/no as `true`/`false`.
    static func plainValue(_ value: JSONValue?) -> String {
        switch value {
        case nil: return "undefined"
        case .null: return "null"
        case .bool(let flag): return String(flag)
        case .int(let number): return String(number)
        case .double(let number): return number.rounded() == number ? String(Int(number)) : String(number)
        case .string(let text): return text
        case .array(let items): return items.map { plainValue($0) }.joined(separator: ",")
        case .object: return json(value ?? .null)
        }
    }

    private static func json(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        do {
            return String(decoding: try encoder.encode(value), as: UTF8.self)
        } catch {
            DiagnosticLog.log("automation describe: value did not encode", tag: "automation", level: .warn, fields: ["error": String(describing: error)])
            return "?"
        }
    }
}
