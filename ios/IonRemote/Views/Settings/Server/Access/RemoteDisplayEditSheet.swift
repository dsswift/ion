import SwiftUI

/// Edits the name and icon every paired phone shows for a server. This is the
/// server's own setting: it changes what every phone sees, unlike the label
/// this phone keeps for the server.
struct RemoteDisplayEditSheet: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let model: PhoneRelayAdminModel
    @State private var name: String
    @State private var icon: String?

    private let columns = [GridItem(.adaptive(minimum: 72, maximum: 96), spacing: IonSpace.compactGap)]

    init(model: PhoneRelayAdminModel) {
        self.model = model
        _name = State(initialValue: model.display?.customName ?? "")
        _icon = State(initialValue: model.display?.customIcon)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Host name", text: $name)
                        .textInputAutocapitalization(.words)
                        .disabled(model.savingDisplay)
                } header: {
                    Text("Name")
                } footer: {
                    Text("Shown on every paired phone. Leave it blank to use the host name.")
                }
                Section("Icon") {
                    LazyVGrid(columns: columns, spacing: IonSpace.compactGap) {
                        tile(id: nil, label: "Default", symbol: PairedDevice.defaultIconSymbol)
                        ForEach(DeviceCustomizationSheet.iconChoices) { choice in
                            tile(id: choice.id, label: choice.label, symbol: choice.symbol)
                        }
                    }
                    .padding(.vertical, IonSpace.hairlineGap)
                }
                Section {
                    Button("Reset to default") { save(name: nil, icon: nil) }
                        .disabled(model.savingDisplay)
                } footer: {
                    if let error = model.displayError {
                        Text(error).foregroundStyle(theme.statusError)
                    }
                }
            }
            .navigationTitle("Name on phones")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.savingDisplay {
                        ProgressView()
                    } else {
                        Button("Save") { save(name: name, icon: icon) }
                    }
                }
            }
        }
    }

    private func save(name: String?, icon: String?) {
        Task {
            if await model.saveDisplay(name: name, icon: icon) { dismiss() }
        }
    }

    private func tile(id: String?, label: String, symbol: String) -> some View {
        let selected = icon == id
        return Button {
            icon = id
        } label: {
            VStack(spacing: IonSpace.hairlineGap) {
                Image(systemName: symbol)
                    .font(.title3)
                    .symbolVariant(selected ? .fill : .none)
                Text(label).font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(selected ? theme.accent : theme.textPrimary)
            .background(RoundedRectangle(cornerRadius: IonRadius.container).fill(selected ? theme.accentSubtle : Color.secondary.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: IonRadius.container).strokeBorder(selected ? theme.accent : .clear))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
