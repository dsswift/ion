import Foundation
import Observation

/// The automation editor's draft: Name and When, If, Then. Every control
/// offers only what the chosen event and field allow; grouped conditions and
/// branch steps it cannot edit are kept verbatim and reported read-only.
@MainActor
@Observable
final class AutomationEditorModel {

    var draft: AutomationDefinition
    let isNew: Bool

    init(definition: AutomationDefinition, isNew: Bool) {
        draft = AutomationDraft.normalize(definition)
        self.isNew = isNew
    }

    var title: String { isNew ? "New Automation" : "Edit \(draft.name.isEmpty ? "Automation" : draft.name)" }
    var trigger: AutomationTriggerSpec? { AutomationCatalog.trigger(draft.trigger.event) }
    /// Nil when the rule uses grouped conditions the editor cannot edit.
    var conditions: [AutomationCondition]? { AutomationDraft.flatConditions(draft.condition) }
    var actions: [AutomationAction] { AutomationDraft.plainActions(AutomationDraft.steps(draft)) }
    var branchCount: Int { AutomationDraft.branchSteps(AutomationDraft.steps(draft)).count }

    /// The definition Save sends.
    func finalized(now: Date = Date()) -> AutomationDefinition { AutomationDraft.finalize(draft, now: now) }

    /// Nil when the rule can be saved; else why not.
    var validationError: String? {
        if draft.trigger.event.isEmpty { return "Select an event first." }
        return AutomationCatalog.validationError(finalized())
    }

    /// The one-line description of what the rule does.
    var preview: String { AutomationDescribe.preview(finalized()) }

    // MARK: When

    func setEvent(_ event: String) {
        draft = AutomationDraft.settingEvent(event, on: draft)
    }

    // MARK: If

    func addCondition() {
        guard let trigger, let current = conditions, let next = AutomationDraft.defaultCondition(trigger) else { return }
        setConditions(current + [next])
    }

    func removeConditions(at offsets: IndexSet) {
        guard var current = conditions else { return }
        current.remove(atOffsets: offsets)
        setConditions(current)
    }

    func setField(_ path: String, at index: Int) {
        guard let field = trigger?.field(path) else { return }
        replaceCondition(at: index, with: AutomationDraft.condition(forField: field))
    }

    func setOperator(_ op: AutomationConditionOperator, at index: Int) {
        guard let current = conditions, current.indices.contains(index), let field = field(for: current[index]) else { return }
        replaceCondition(at: index, with: AutomationDraft.condition(current[index], field: field, operator: op))
    }

    func setValue(_ value: JSONValue, at index: Int) {
        guard var condition = conditions?[safe: index] else { return }
        condition.value = value
        replaceCondition(at: index, with: condition)
    }

    /// The catalog field a condition compares; the trigger's first when it names an unknown one.
    func field(for condition: AutomationCondition) -> AutomationFieldSpec? {
        trigger?.field(condition.path) ?? trigger?.fields.first
    }

    private func replaceCondition(at index: Int, with condition: AutomationCondition) {
        guard var current = conditions, current.indices.contains(index) else { return }
        current[index] = condition
        setConditions(current)
    }

    private func setConditions(_ next: [AutomationCondition]) {
        draft = AutomationDraft.settingConditions(next, on: draft)
    }

    // MARK: Then

    func addAction() {
        setActions(actions + [AutomationDraft.defaultAction("record")])
    }

    func removeActions(at offsets: IndexSet) {
        var next = actions
        next.remove(atOffsets: offsets)
        setActions(next)
    }

    func moveActions(from source: IndexSet, to destination: Int) {
        var next = actions
        next.move(fromOffsets: source, toOffset: destination)
        setActions(next)
    }

    func setActionKind(_ kind: String, at index: Int) {
        replaceAction(at: index, with: AutomationDraft.defaultAction(kind))
    }

    /// Sets one setting of an action; an empty value removes it.
    func setConfig(_ key: String, to value: JSONValue?, at index: Int) {
        guard var action = actions[safe: index] else { return }
        var payload = action.payload ?? [:]
        if let value, value != .string("") { payload[key] = value } else { payload.removeValue(forKey: key) }
        action.payload = payload
        replaceAction(at: index, with: action)
    }

    private func replaceAction(at index: Int, with action: AutomationAction) {
        var next = actions
        guard next.indices.contains(index) else { return }
        next[index] = action
        setActions(next)
    }

    private func setActions(_ next: [AutomationAction]) {
        draft = AutomationDraft.settingActions(next, on: draft)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
