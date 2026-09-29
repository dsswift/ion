import SwiftUI

/// One projected setting, as a native row sized to its type: a toggle, a text
/// field, a stepper, a menu picker, or a list editor. Reads and saves through
/// `projectedSettingsSource` when a server page set one, else through the
/// connected server.
struct ProjectedSettingRow: View {
    let entry: ServerSettingSchemaEntry
    let state: ServerSettingsState

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.projectedSettingsSource) private var source

    var body: some View {
        switch entry.type {
        case .boolean: booleanRow
        case .string: stringRow
        case .number: numberRow
        case .enumType: enumRow
        case .list:
            if entry.itemType != nil {
                ServerSettingsPrimitiveListEditor(entry: entry, state: state)
            } else {
                listRow
            }
        }
    }

    private func save(_ value: AnyCodable) {
        if let source { source.write(entry.key, value) } else { viewModel.setServerSetting(key: entry.key, value: value) }
    }

    private var caption: some View {
        Text(entry.description)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var booleanRow: some View {
        let current = (state.currentValue(for: entry.key)?.value as? Bool) ?? false
        return Toggle(isOn: Binding(get: { current }, set: { save(AnyCodable($0)); Haptic.light() })) {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.label).font(.body)
                caption
            }
            .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
        }
    }

    private var stringRow: some View {
        let current = (state.currentValue(for: entry.key)?.value as? String) ?? ""
        return VStack(alignment: .leading, spacing: 4) {
            Text(entry.label).font(.body)
            TextField(entry.label, text: Binding(get: { current }, set: { save(AnyCodable($0)) }))
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            caption
        }
        .padding(.vertical, IonSpace.hairlineGap)
    }

    private var numberRow: some View {
        let current = state.currentValue(for: entry.key)?.doubleValue ?? 0
        let bounds = entry.range.map { $0.min...$0.max } ?? 0...10000
        let step = entry.range?.step ?? 1
        return VStack(alignment: .leading, spacing: 4) {
            Stepper(value: Binding(get: { current }, set: { save(AnyCodable($0)) }), in: bounds, step: step) {
                HStack {
                    Text(entry.label).font(.body)
                    Spacer()
                    Text(Self.formatStepperValue(current, step: step)).foregroundStyle(.secondary)
                }
            }
            caption
        }
        .padding(.vertical, IonSpace.hairlineGap)
    }

    /// One decimal for fractional steps ("1.5"), whole numbers otherwise ("120").
    static func formatStepperValue(_ value: Double, step: Double) -> String {
        step < 1 ? String(format: "%.1f", value) : String(Int(value.rounded()))
    }

    private var enumRow: some View {
        let choices = entry.choices ?? []
        let raw = state.currentValue(for: entry.key)?.value
        // The "None" choice's selection key is the empty string; it goes back out as JSON null.
        let currentKey: String = {
            if raw == nil || raw is NSNull { return "" }
            if let text = raw as? String { return text }
            return String(describing: raw!)
        }()
        return VStack(alignment: .leading, spacing: 4) {
            Picker(entry.label, selection: Binding(
                get: { currentKey },
                set: { key in
                    save(choices.first { $0.selectionKey == key }?.value ?? AnyCodable(NSNull()))
                    Haptic.light()
                }
            )) {
                ForEach(choices) { Text($0.label).tag($0.selectionKey) }
            }
            .pickerStyle(.menu)
            caption
        }
        .padding(.vertical, IonSpace.hairlineGap)
    }

    private var listRow: some View {
        let count = ((state.currentValue(for: entry.key)?.value as? [AnyCodable]) ?? []).count
        return NavigationLink {
            ServerSettingsListEditor(entry: entry)
                .environment(viewModel)
                .environment(\.projectedSettingsSource, source)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(entry.label).font(.body)
                    Spacer()
                    Text("\(count)").foregroundStyle(.secondary)
                }
                caption
            }
            .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
        }
    }
}

/// The projected settings one taxonomy section shows, one row each. Rows this
/// connection may not change stay visible and disabled.
struct ProjectedSectionRows: View {
    let state: ServerSettingsState
    let pageId: String
    let sectionId: String

    var body: some View {
        ForEach(state.entries(page: pageId, section: sectionId)) { entry in
            ProjectedSettingRow(entry: entry, state: state)
                .disabled(state.isReadOnly(entry))
        }
    }
}
