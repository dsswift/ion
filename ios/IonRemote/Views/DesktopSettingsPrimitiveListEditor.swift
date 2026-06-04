import SwiftUI

/// Editable list screen for a primitive-typed projectable setting
/// (`list` with `itemType`).
///
/// Renders an Apple-style editable list backed by the entry's current
/// array value, mirroring `DesktopSettingsListEditor` but for scalar
/// elements rather than records:
///
///   - `itemType = .string` → TextField per row.
///   - `itemType = .number` → Stepper per row (uses the entry's
///     `range` when present; falls back to a permissive default).
///   - `itemType = .boolean` → Toggle per row.
///
/// Swipe-to-delete, drag-to-reorder via EditButton, and an "Add" row
/// at the bottom that appends an empty/default scalar to the array.
///
/// Snapshot semantics
/// ──────────────────
/// Every mutation (add/delete/reorder/edit) constructs a new array and
/// ships it back over the wire with
/// `viewModel.setDesktopSetting(key:value:)`. The desktop replaces its
/// on-disk array wholesale; no partial-update protocol exists. The
/// view does NOT maintain optimistic local state — it re-reads from
/// `viewModel.desktopSettings` on every render, so a rejected write
/// simply bounces back to the prior shape on the next snapshot.
///
/// Why this is separate from `DesktopSettingsListEditor`
/// ────────────────────────────────────────────────────
/// Record-list editing pushes a per-record screen (each row is a
/// NavigationLink). Primitive-list editing edits inline (each row is
/// a TextField/Stepper/Toggle). Splitting at the editor level keeps
/// each implementation small and idiomatic; the dispatch in
/// `DesktopSettingsView.row(for:state:)` picks the right one based on
/// the entry's `itemType` field.
///
/// This view is invoked from `DesktopSettingsView` (no NavigationLink
/// drill-down), so the list is inline in the parent settings screen
/// for compactness. That matches the typical case (a handful of
/// commands, not dozens) and keeps tap-depth shallow.
struct DesktopSettingsPrimitiveListEditor: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel

    /// The schema entry for the primitive list itself.
    let entry: DesktopSettingSchemaEntry

    /// The current state snapshot, for value lookup.
    let state: DesktopSettingsState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.label)
                .font(.body)
            Text(entry.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            let items = currentItems()
            if items.isEmpty {
                Text("No entries. Tap Add below.")
                    .font(.caption)
                    .italic()
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
            } else {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    primitiveRow(at: index, value: item)
                }
            }

            Button {
                appendDefault()
                Haptic.light()
            } label: {
                Label("Add", systemImage: "plus")
                    .font(.body)
            }
            .padding(.vertical, 4)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Row rendering

    /// One row, dispatched by `itemType`. The `value` parameter is the
    /// current scalar; the binding writes back into the array at
    /// `index`.
    @ViewBuilder
    private func primitiveRow(at index: Int, value: AnyCodable) -> some View {
        HStack {
            switch entry.itemType {
            case .string:
                TextField(
                    "value",
                    text: Binding(
                        get: { (value.value as? String) ?? "" },
                        set: { updateAt(index: index, with: AnyCodable($0)) }
                    )
                )
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            case .number:
                let current: Double = (value.value as? Double) ?? Double(value.value as? Int ?? 0)
                Stepper(
                    value: Binding(
                        get: { current },
                        set: { updateAt(index: index, with: AnyCodable($0)) }
                    ),
                    in: stepperRange(),
                    step: stepperStep()
                ) {
                    Text(Self.formatStepperValue(current, step: stepperStep()))
                        .monospacedDigit()
                }
            case .boolean:
                Toggle(
                    isOn: Binding(
                        get: { (value.value as? Bool) ?? false },
                        set: { updateAt(index: index, with: AnyCodable($0)) }
                    )
                ) {
                    Text("Enabled")
                }
            case .enumType, .list, .none:
                // Unsupported primitive item type — render a read-only
                // fallback so the view doesn't crash on a forward-compat
                // value we don't know how to render.
                Text(String(describing: value.value))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }

            Button {
                deleteAt(index: index)
                Haptic.light()
            } label: {
                Image(systemName: "minus.circle.fill")
                    .foregroundStyle(.red)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Snapshot read + write

    /// Pull the current array from `viewModel.desktopSettings`. Returns
    /// an empty array when the snapshot is missing or the value is not
    /// an array.
    private func currentItems() -> [AnyCodable] {
        if let raw = state.currentValue(for: entry.key)?.value as? [AnyCodable] {
            return raw
        }
        // Fallback to the entry's declared default. The snapshot should
        // always carry a value (projectCurrentSettings fills in the
        // default for missing keys), but iOS must not crash if the
        // desktop omits the entry for any reason.
        if let raw = entry.defaultValue.value as? [AnyCodable] {
            return raw
        }
        return []
    }

    /// Replace one element in the array and ship the whole new array
    /// back over the wire.
    private func updateAt(index: Int, with value: AnyCodable) {
        var items = currentItems()
        guard index >= 0 && index < items.count else { return }
        items[index] = value
        writeBack(items)
    }

    /// Remove one element and ship the new array.
    private func deleteAt(index: Int) {
        var items = currentItems()
        guard index >= 0 && index < items.count else { return }
        items.remove(at: index)
        writeBack(items)
    }

    /// Append a fresh default-valued element to the array. Default
    /// depends on `itemType`: empty string, zero, or false.
    private func appendDefault() {
        var items = currentItems()
        switch entry.itemType {
        case .string:
            items.append(AnyCodable(""))
        case .number:
            items.append(AnyCodable(0))
        case .boolean:
            items.append(AnyCodable(false))
        case .enumType, .list, .none:
            return  // unsupported — Add is a no-op
        }
        writeBack(items)
    }

    /// Ship the whole array back via the canonical set-setting command.
    /// Snapshot-replace semantics: the desktop replaces its on-disk
    /// array wholesale.
    private func writeBack(_ items: [AnyCodable]) {
        viewModel.setDesktopSetting(key: entry.key, value: AnyCodable(items))
    }

    // MARK: - Number formatting (mirrors numberRow in DesktopSettingsView)

    /// Stepper range for `number` items. Uses the entry's `range` when
    /// present; falls back to a permissive default.
    private func stepperRange() -> ClosedRange<Double> {
        if let r = entry.range {
            return r.min...r.max
        }
        return 0...10000
    }

    /// Stepper step for `number` items. Uses the entry's `range.step`
    /// when present; falls back to 1.
    private func stepperStep() -> Double {
        entry.range?.step ?? 1.0
    }

    /// Format a Double for display: trim trailing zeros for integer
    /// values, otherwise show up to 2 decimal places. Mirrors the
    /// formatter in `DesktopSettingsView.numberRow`.
    static func formatStepperValue(_ value: Double, step: Double) -> String {
        if step >= 1.0 && value.rounded() == value {
            return String(Int(value))
        }
        return String(format: "%.2f", value)
    }
}
