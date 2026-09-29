import Foundation

/// Strict validation for a definition the person authored, the same the
/// server runs before it saves one: any trigger, field, operator, value, or
/// action the catalog does not model is refused, with the reason.
extension AutomationCatalog {

    /// Nil when `definition` can run; else why it cannot.
    static func validationError(_ definition: AutomationDefinition) -> String? {
        guard let trigger = trigger(definition.trigger.event) else {
            return "Unknown trigger event: \(definition.trigger.event)"
        }
        if let error = groupError(definition.condition, trigger) { return error }
        return stepsError(definition.steps ?? definition.actions?.map(AutomationStep.action) ?? [], trigger)
    }

    private static func groupError(_ group: AutomationConditionGroup?, _ trigger: AutomationTriggerSpec) -> String? {
        guard let group else { return nil }
        for item in (group.all ?? []) + (group.any ?? []) {
            let error: String?
            switch item {
            case .condition(let condition): error = conditionError(condition, trigger)
            case .group(let nested): error = groupError(nested, trigger)
            }
            if let error { return error }
        }
        return nil
    }

    private static func conditionError(_ condition: AutomationCondition, _ trigger: AutomationTriggerSpec) -> String? {
        guard let field = trigger.field(condition.path) else { return "\"\(trigger.label)\" has no field \(condition.path)" }
        guard field.operators.contains(condition.operator) else { return "\(field.label) cannot use operator \(condition.operator.rawValue)" }
        if condition.operator.isPresence { return nil }
        guard let value = condition.value else { return "\(field.label) requires a value" }
        switch field.type {
        case .enumType:
            return (field.values ?? []).contains { .string($0.value) == value } ? nil : "\(field.label) does not allow \(AutomationDescribe.plainValue(value))"
        case .boolean:
            return value.boolValue != nil ? nil : "\(field.label) requires yes or no"
        case .number:
            return value.numberValue != nil ? nil : "\(field.label) requires a number"
        case .string, .path:
            return value.stringValue != nil ? nil : "\(field.label) requires text"
        }
    }

    private static func stepsError(_ steps: [AutomationStep], _ trigger: AutomationTriggerSpec) -> String? {
        for step in steps {
            switch step {
            case .branch(let branch):
                if let error = groupError(branch.condition, trigger) { return error }
                if let error = stepsError(branch.then, trigger) { return error }
                if let error = stepsError(branch.else ?? [], trigger) { return error }
            case .action(let action):
                if let error = actionError(action, trigger) { return error }
            }
        }
        return nil
    }

    private static func actionError(_ action: AutomationAction, _ trigger: AutomationTriggerSpec) -> String? {
        guard let spec = self.action(action.kind) else { return "Unknown action: \(action.kind)" }
        let payload = action.payload ?? [:]
        if let error = targetError(spec, trigger, payload) { return error }
        for field in spec.config {
            guard let value = payload[field.key], value != .null, value != .string("") else {
                if field.required { return "\(spec.label) requires \(field.label)" }
                continue
            }
            if let error = configValueError(spec, field, value) { return error }
        }
        return nil
    }

    private static func targetError(_ spec: AutomationActionSpec, _ trigger: AutomationTriggerSpec, _ payload: [String: JSONValue]) -> String? {
        switch spec.target {
        case .none:
            return nil
        case .worktree:
            return trigger.provides.worktree ? nil : "\"\(trigger.label)\" cannot supply a worktree for \(spec.label)"
        case .conversation:
            return trigger.provides.conversation ? nil : "\"\(trigger.label)\" cannot supply a conversation for \(spec.label)"
        case .directory:
            return trigger.provides.worktree || payload["directory"]?.stringValue != nil ? nil : "\(spec.label) needs a directory this trigger cannot supply"
        }
    }

    private static func configValueError(_ spec: AutomationActionSpec, _ field: AutomationActionConfigField, _ value: JSONValue) -> String? {
        switch field.type {
        case .enumType:
            return (field.values ?? []).contains { .string($0.value) == value } ? nil : "\(spec.label): \(field.label) does not allow \(AutomationDescribe.plainValue(value))"
        case .boolean:
            return value.boolValue != nil ? nil : "\(spec.label): \(field.label) must be yes or no"
        case .number:
            return value.numberValue != nil ? nil : "\(spec.label): \(field.label) must be a number"
        case .string, .path:
            return value.stringValue != nil ? nil : "\(spec.label): \(field.label) must be text"
        }
    }
}
