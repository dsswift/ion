import SwiftUI

/// Per-record edit sheet for one row of a list-typed projectable
/// setting (e.g. one QuickTool, one TabGroup).
///
/// Renders one row per `itemSchema` entry, reusing the same row
/// renderers as the parent `DesktopSettingsView` (boolean, string,
/// number, enum). The form is staged in local state until the user
/// taps "Save", at which point the full updated record is handed back
/// to the parent list editor via `onSave`. This isolates per-record
/// edits from the wire round-trip — the wire write only fires when
/// the user explicitly commits, not on every keystroke.
///
/// Why a sheet instead of inline push
/// ──────────────────────────────────
/// The parent list editor presents this as a `.sheet`, not a
/// NavigationLink, for two reasons:
///   1. Swipe-down to dismiss matches Apple's pattern for "modal
///      form editing" (e.g. New Reminder, New Calendar Event).
///   2. Save/Cancel buttons in the toolbar give the user an explicit
///      commit ramp — no risk of half-saved state from accidental
///      back-navigation mid-edit.
///
/// The `id` field is excluded from rendering (auto-assigned UUID, not
/// user-editable). All other itemSchema fields are rendered in order.
struct DesktopSettingsListRecordEditor: View {
    @Environment(\.appTheme) private var theme

    let title: String
    let schema: [DesktopSettingSchemaEntry]
    /// Initial state of the record being edited. Used to seed the
    /// staged values; the editor only writes to the staged copy.
    let record: DesktopSettingsListEditor.ListRecord
    let onSave: (DesktopSettingsListEditor.ListRecord) -> Void
    let onCancel: () -> Void

    /// Staged field values. Initialized from `record.fields` on
    /// appear, mutated by the inline row renderers, and shipped back
    /// via `onSave`. Holding the staging here (rather than going
    /// straight to the wire) is what makes the Save/Cancel pair work.
    @State private var staged: [String: AnyCodable] = [:]

    var body: some View {
        List {
            ForEach(schema) { entry in
                if !DesktopSettingsListEditor.hiddenFieldKeys.contains(entry.key) {
                    recordFieldRow(entry: entry)
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { onCancel() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save") {
                    let merged = DesktopSettingsListEditor.ListRecord(
                        id: record.id,
                        fields: stagedWithId,
                    )
                    onSave(merged)
                }
                .fontWeight(.semibold)
            }
        }
        .onAppear {
            // Seed staged state from the record's fields. Defensive
            // fallback: any field absent from the record gets the
            // schema default so the editor never shows an empty
            // control on a partially-populated record.
            var seeded = record.fields
            for entry in schema where seeded[entry.key] == nil {
                seeded[entry.key] = entry.defaultValue
            }
            staged = seeded
        }
    }

    /// Staged fields with hidden fields preserved (the editor renders
    /// without `id`, `order`, `collapsed`, but the wire write needs
    /// to carry those through unchanged from the original record).
    private var stagedWithId: [String: AnyCodable] {
        var out = staged
        for key in DesktopSettingsListEditor.hiddenFieldKeys {
            if let preserved = record.fields[key] {
                out[key] = preserved
            }
        }
        // The id field always needs to be present; fall back to the
        // record's own id if the original dictionary somehow omitted
        // it (defensive — shouldn't happen in practice).
        if out["id"] == nil {
            out["id"] = AnyCodable(record.id)
        }
        return out
    }

    /// One row of the per-record editor. Picks the same renderer the
    /// top-level Desktop Settings view uses, but writes into the
    /// staged dictionary instead of the wire. We can't call into the
    /// parent view's row renderers directly because those write
    /// straight to the wire — the staged-write requirement forces a
    /// parallel implementation here.
    @ViewBuilder
    private func recordFieldRow(entry: DesktopSettingSchemaEntry) -> some View {
        switch entry.type {
        case .boolean:
            booleanFieldRow(entry: entry)
        case .string:
            stringFieldRow(entry: entry)
        case .number:
            numberFieldRow(entry: entry)
        case .enumType:
            enumFieldRow(entry: entry)
        case .list:
            // Lists-within-lists are not supported today. Render a
            // read-only placeholder so we don't crash if a future
            // desktop ships one.
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.label).font(.body)
                Text("Nested lists are not editable on this version of iOS Remote.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    // ─── Field row renderers ──────────────────────────────────────────
    // These mirror DesktopSettingsView's row renderers but target the
    // staged dictionary instead of the wire. Kept short — the editor
    // only renders one record's fields at a time.

    @ViewBuilder
    private func booleanFieldRow(entry: DesktopSettingSchemaEntry) -> some View {
        let current = (staged[entry.key]?.value as? Bool) ?? false
        Toggle(isOn: Binding(
            get: { current },
            set: { staged[entry.key] = AnyCodable($0) }
        )) {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.label).font(.body)
                Text(entry.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func stringFieldRow(entry: DesktopSettingSchemaEntry) -> some View {
        let current = (staged[entry.key]?.value as? String) ?? ""
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.label).font(.body)
            TextField(entry.label, text: Binding(
                get: { current },
                set: { staged[entry.key] = AnyCodable($0) }
            ))
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            Text(entry.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func numberFieldRow(entry: DesktopSettingSchemaEntry) -> some View {
        let current = (staged[entry.key]?.value as? Double) ?? 0
        let bounds = entry.range.map { $0.min...$0.max } ?? 0...10000
        let step = entry.range?.step ?? 1
        VStack(alignment: .leading, spacing: 4) {
            Stepper(value: Binding(
                get: { current },
                set: { staged[entry.key] = AnyCodable($0) }
            ), in: bounds, step: step) {
                HStack {
                    Text(entry.label).font(.body)
                    Spacer()
                    Text(DesktopSettingsView.formatStepperValue(current, step: step))
                        .foregroundStyle(.secondary)
                }
            }
            Text(entry.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func enumFieldRow(entry: DesktopSettingSchemaEntry) -> some View {
        let choices = entry.choices ?? []
        let currentRaw = staged[entry.key]?.value
        let currentKey: String = {
            if currentRaw is NSNull || currentRaw == nil { return "" }
            if let s = currentRaw as? String { return s }
            return String(describing: currentRaw!)
        }()
        VStack(alignment: .leading, spacing: 4) {
            Picker(entry.label, selection: Binding(
                get: { currentKey },
                set: { newKey in
                    let selected = choices.first { $0.selectionKey == newKey }
                    let wireValue = selected?.value ?? AnyCodable(NSNull())
                    staged[entry.key] = wireValue
                }
            )) {
                ForEach(choices) { choice in
                    Text(choice.label).tag(choice.selectionKey)
                }
            }
            .pickerStyle(.menu)
            Text(entry.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }
}
