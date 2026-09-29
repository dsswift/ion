import SwiftUI

/// One condition: the event field, how it compares, and the value, each
/// offering only what the field allows.
struct AutomationConditionRow: View {
    let editor: AutomationEditorModel
    let trigger: AutomationTriggerSpec
    let condition: AutomationCondition
    let index: Int

    var body: some View {
        let field = editor.field(for: condition)
        VStack(alignment: .leading, spacing: IonSpace.compactGap) {
            Picker("Field", selection: Binding(get: { condition.path }, set: { editor.setField($0, at: index) })) {
                if trigger.field(condition.path) == nil { Text(condition.path).tag(condition.path) }
                ForEach(trigger.fields, id: \.path) { Text($0.label).tag($0.path) }
            }
            if let field {
                Picker("Compare", selection: Binding(get: { condition.operator }, set: { editor.setOperator($0, at: index) })) {
                    if !field.operators.contains(condition.operator) {
                        Text(AutomationDescribe.operatorLabel(condition.operator)).tag(condition.operator)
                    }
                    ForEach(field.operators, id: \.self) { Text(AutomationDescribe.operatorLabel($0)).tag($0) }
                }
                if !condition.operator.isPresence {
                    AutomationValueControl(
                        label: "Value",
                        type: field.type,
                        choices: field.values,
                        allowsNone: false,
                        value: condition.value,
                        onChange: { editor.setValue($0 ?? .string(""), at: index) }
                    )
                }
            }
        }
        .padding(.vertical, IonSpace.hairlineGap)
    }
}
