import Foundation

/// Catalog-driven draft helpers for the automation editor. A copy of
/// `desktop/src/renderer/components/settings/automation-draft.ts`.
///
/// Every new condition and action starts valid: a real field, a real
/// operator, and a value the field accepts. When the event or a field
/// changes, the dependent parts reset to a valid default instead of keeping
/// a combination that could never run.
enum AutomationDraft {

    /// A valid default value for a field and operator; nil for a presence operator.
    static func defaultValue(_ field: AutomationFieldSpec, _ op: AutomationConditionOperator) -> JSONValue? {
        if op.isPresence { return nil }
        switch field.type {
        case .enumType: return .string(field.values?.first?.value ?? "")
        case .boolean: return .bool(false)
        case .number: return .int(0)
        case .string, .path: return .string("")
        }
    }

    /// A valid new condition for `trigger`: its first field, first operator, a valid value.
    static func defaultCondition(_ trigger: AutomationTriggerSpec) -> AutomationCondition? {
        guard let field = trigger.fields.first, let op = field.operators.first else { return nil }
        return AutomationCondition(path: field.path, operator: op, value: defaultValue(field, op))
    }

    /// A condition re-seeded after its field changed, with a valid operator.
    static func condition(forField field: AutomationFieldSpec) -> AutomationCondition {
        let op = field.operators.first ?? .exists
        return AutomationCondition(path: field.path, operator: op, value: defaultValue(field, op))
    }

    /// A condition re-seeded after its operator changed.
    static func condition(_ condition: AutomationCondition, field: AutomationFieldSpec, operator op: AutomationConditionOperator) -> AutomationCondition {
        AutomationCondition(path: condition.path, operator: op, value: defaultValue(field, op))
    }

    /// A valid new action, with every required setting filled with a real value.
    static func defaultAction(_ kind: String) -> AutomationAction {
        guard let spec = AutomationCatalog.action(kind) else { return AutomationAction(kind: kind) }
        var payload: [String: JSONValue] = [:]
        for field in spec.config where field.required {
            switch field.type {
            case .enumType: payload[field.key] = .string(field.values?.first?.value ?? "")
            case .boolean: payload[field.key] = .bool(false)
            case .number: payload[field.key] = .int(0)
            case .string, .path: payload[field.key] = .string("")
            }
        }
        return AutomationAction(kind: kind, payload: spec.config.isEmpty ? nil : payload)
    }

    /// The flat top-level `all` conditions, or nil when the group uses `any`
    /// or nested groups. The editor edits the flat form; anything richer is
    /// shown read-only and kept as it is.
    static func flatConditions(_ group: AutomationConditionGroup?) -> [AutomationCondition]? {
        guard let group else { return [] }
        if let any = group.any, !any.isEmpty { return nil }
        var flat: [AutomationCondition] = []
        for item in group.all ?? [] {
            guard case .condition(let condition) = item else { return nil }
            flat.append(condition)
        }
        return flat
    }

    static func hasBranchSteps(_ steps: [AutomationStep]) -> Bool {
        steps.contains { if case .branch = $0 { return true } else { return false } }
    }

    /// The plain ordered actions; branches are left out.
    static func plainActions(_ steps: [AutomationStep]) -> [AutomationAction] {
        steps.compactMap { if case .action(let action) = $0 { return action } else { return nil } }
    }

    static func branchSteps(_ steps: [AutomationStep]) -> [AutomationBranchStep] {
        steps.compactMap { if case .branch(let branch) = $0 { return branch } else { return nil } }
    }

    /// Drops conditions whose field or operator the new trigger does not carry.
    static func keepValidConditions(_ conditions: [AutomationCondition], _ trigger: AutomationTriggerSpec) -> [AutomationCondition] {
        conditions.filter { condition in
            trigger.field(condition.path)?.operators.contains(condition.operator) ?? false
        }
    }

    /// Drops actions whose target the new trigger cannot supply.
    static func keepValidActions(_ actions: [AutomationAction], _ trigger: AutomationTriggerSpec) -> [AutomationAction] {
        actions.filter { targetSatisfied(AutomationCatalog.action($0.kind), trigger, $0) }
    }

    static func targetSatisfied(_ spec: AutomationActionSpec?, _ trigger: AutomationTriggerSpec, _ action: AutomationAction) -> Bool {
        guard let spec else { return false }
        switch spec.target {
        case .none: return true
        case .worktree: return trigger.provides.worktree
        case .conversation: return trigger.provides.conversation
        case .directory: return trigger.provides.worktree || action.payload?["directory"]?.stringValue != nil
        }
    }

    /// The steps a definition runs: `steps`, else the legacy `actions`.
    static func steps(_ definition: AutomationDefinition) -> [AutomationStep] {
        definition.steps ?? definition.actions?.map(AutomationStep.action) ?? []
    }

    /// The definition with its legacy `actions` moved into `steps`.
    static func normalize(_ definition: AutomationDefinition) -> AutomationDefinition {
        var normalized = definition
        normalized.steps = steps(definition)
        normalized.actions = nil
        return normalized
    }

    /// The draft after its event changed: conditions and actions the new
    /// event cannot carry are dropped; branch steps are kept as they are.
    static func settingEvent(_ event: String, on draft: AutomationDefinition) -> AutomationDefinition {
        var next = draft
        let current = steps(draft)
        let trigger = AutomationCatalog.trigger(event)
        let conditions = trigger.map { keepValidConditions(flatConditions(draft.condition) ?? [], $0) } ?? []
        let actions = trigger.map { keepValidActions(plainActions(current), $0) } ?? plainActions(current)
        next.trigger = AutomationTrigger(event: event)
        next.condition = conditions.isEmpty ? nil : AutomationConditionGroup(all: conditions.map(AutomationConditionExpression.condition))
        next.steps = actions.map(AutomationStep.action) + branchSteps(current).map(AutomationStep.branch)
        next.actions = nil
        return next
    }

    /// The draft with its flat conditions replaced.
    static func settingConditions(_ conditions: [AutomationCondition], on draft: AutomationDefinition) -> AutomationDefinition {
        var next = draft
        next.condition = conditions.isEmpty ? nil : AutomationConditionGroup(all: conditions.map(AutomationConditionExpression.condition))
        return next
    }

    /// The draft with its plain actions replaced; branch steps stay after them.
    static func settingActions(_ actions: [AutomationAction], on draft: AutomationDefinition) -> AutomationDefinition {
        var next = draft
        next.steps = actions.map(AutomationStep.action) + branchSteps(steps(draft)).map(AutomationStep.branch)
        next.actions = nil
        return next
    }

    // MARK: New and saved definitions

    /// An ISO 8601 time the way the server writes one (`2026-01-01T00:00:00.000Z`).
    static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func newId() -> String { UUID().uuidString.lowercased() }

    static func blank(now: Date = Date()) -> AutomationDefinition {
        let stamp = timestamp(now)
        return AutomationDefinition(id: "", name: "", enabled: true, trigger: AutomationTrigger(event: ""), condition: nil, steps: [], actions: nil, createdAt: stamp, updatedAt: stamp)
    }

    /// The definition Save sends: a real id and name, steps only, a fresh timestamp.
    static func finalize(_ draft: AutomationDefinition, now: Date = Date(), newId: () -> String = newId) -> AutomationDefinition {
        var final = draft
        let id = draft.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        final.id = id.isEmpty ? "user.\(newId())" : id
        final.name = name.isEmpty ? "Untitled automation" : name
        final.trigger = AutomationTrigger(event: draft.trigger.event.trimmingCharacters(in: .whitespacesAndNewlines))
        final.steps = steps(draft)
        final.actions = nil
        final.updatedAt = timestamp(now)
        return final
    }
}
