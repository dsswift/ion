import SwiftUI

/// A model picker pushed as its own list: an empty choice, then each
/// provider's models under its name.
struct ModelChoicePicker: View {
    let title: String
    let emptyLabel: String
    let groups: [ModelChoiceGroup]
    @Binding var selection: String

    var body: some View {
        Picker(title, selection: $selection) {
            Text(emptyLabel).tag("")
            ForEach(groups) { group in
                Section(group.label) {
                    ForEach(group.choices) { choice in
                        Text(choice.label)
                            .foregroundStyle(choice.unavailable ? .secondary : .primary)
                            .tag(choice.value)
                    }
                }
            }
        }
        .pickerStyle(.navigationLink)
    }
}
