import SwiftUI

/// A control sized to a catalog value: a menu of choices, a yes/no switch, a
/// number field, or a text field.
struct AutomationValueControl: View {
    let label: String
    let type: AutomationFieldType
    let choices: [AutomationFieldChoice]?
    /// An optional enum setting offers "Any" (no value).
    let allowsNone: Bool
    let value: JSONValue?
    let onChange: (JSONValue?) -> Void

    var body: some View {
        switch type {
        case .enumType:
            Picker(label, selection: Binding(get: { value?.stringValue ?? "" }, set: { onChange($0.isEmpty ? nil : .string($0)) })) {
                if allowsNone { Text("Any").tag("") }
                if let current = value?.stringValue, !current.isEmpty, !(choices ?? []).contains(where: { $0.value == current }) {
                    Text(current).tag(current)
                }
                ForEach(choices ?? [], id: \.value) { Text($0.label).tag($0.value) }
            }
        case .boolean:
            Toggle(label, isOn: Binding(get: { value?.boolValue ?? false }, set: { onChange(.bool($0)) }))
        case .number:
            LabeledContent(label) {
                TextField(label, value: Binding(get: { value?.numberValue ?? 0 }, set: { onChange($0.rounded() == $0 ? .int(Int($0)) : .double($0)) }), format: .number)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
            }
        case .string, .path:
            TextField(label, text: Binding(get: { value?.stringValue ?? "" }, set: { onChange(.string($0)) }))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }
}
