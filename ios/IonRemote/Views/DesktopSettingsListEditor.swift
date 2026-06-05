import SwiftUI

/// Editable list screen for a `list`-typed projectable setting.
///
/// Renders an Apple-style editable list backed by the entry's current
/// array value: swipe-to-delete, drag-to-reorder, "Add" button at the
/// bottom, and push-to-edit per record into `DesktopSettingsListRecordEditor`.
///
/// Snapshot semantics
/// ──────────────────
/// Every mutation (add/delete/reorder/edit) constructs a new array and
/// ships it back over the wire with `set_desktop_setting { key, value }`.
/// The desktop replaces its on-disk array wholesale; no partial-update
/// protocol exists. The view does NOT maintain optimistic local state —
/// it re-reads from `viewModel.desktopSettings` on every render, so a
/// rejected write simply bounces back to the prior shape on the next
/// snapshot.
///
/// Row labels
/// ──────────
/// Each row's primary label is the value of the first non-`id` string
/// field in the `itemSchema` (e.g. `name` for QuickTool, `label` for
/// TabGroup). Falls back to the record's `id` when no string field is
/// available. Apple's Settings.app uses the same "first interesting
/// field as the row title" pattern in the Wi-Fi network list and the
/// VPN list.
struct DesktopSettingsListEditor: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel

    /// Field keys that the list editor auto-manages and never renders
    /// as editable rows. The desktop's `tabGroups` records require
    /// these fields on the wire (or the rest of the desktop codebase
    /// breaks when consuming them), but they are not user-editable
    /// from iOS:
    ///   - `id` — auto-assigned UUID per record.
    ///   - `order` — auto-synced to the iOS list index on every send.
    ///   - `collapsed` — runtime UI state owned by the desktop;
    ///                   preserved on round-trip and defaulted to the
    ///                   schema default on create.
    /// QuickTool records don't use these field names so the skip
    /// affects only the tabGroups projection in practice.
    static let hiddenFieldKeys: Set<String> = ["id", "order", "collapsed"]

    /// The schema entry for the list itself (carries the wire key,
    /// label, description, and `itemSchema` for nested rows).
    let entry: DesktopSettingSchemaEntry

    /// Per-record edit sheet target. Non-nil when the user tapped a
    /// row to push the record editor.
    @State private var editingRecord: ListRecord? = nil
    /// "Add new" sheet target. True while the new-record editor is
    /// up; the staged record is held in `pendingRecord`.
    @State private var showAddSheet = false

    var body: some View {
        List {
            Section {
                let records = currentRecords()
                if records.isEmpty {
                    HStack {
                        Spacer()
                        Text("No entries yet").foregroundStyle(.secondary)
                        Spacer()
                    }
                } else {
                    ForEach(records) { record in
                        Button {
                            editingRecord = record
                            Haptic.light()
                        } label: {
                            recordRow(record)
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { offsets in
                        deleteRecords(at: offsets)
                    }
                    .onMove { source, destination in
                        moveRecords(from: source, to: destination)
                    }
                }

                Button {
                    addNewRecord()
                } label: {
                    Label("Add \(entry.label.lowercased())", systemImage: "plus")
                }
            } footer: {
                Text(entry.description)
            }
        }
        .navigationTitle(entry.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !currentRecords().isEmpty {
                    EditButton()
                }
            }
        }
        .sheet(item: $editingRecord) { record in
            // Push a per-record edit sheet rather than navigating, so
            // the user can dismiss with a swipe-down and the parent
            // list stays mounted (preserving scroll position).
            NavigationStack {
                DesktopSettingsListRecordEditor(
                    title: rowLabel(for: record),
                    schema: entry.itemSchema ?? [],
                    record: record,
                    onSave: { updated in
                        updateRecord(id: record.id, with: updated)
                        editingRecord = nil
                    },
                    onCancel: { editingRecord = nil }
                )
            }
        }
        .sheet(isPresented: $showAddSheet) {
            // Build a fresh record seeded with defaults from the
            // itemSchema. Each scalar field defaults to its declared
            // defaultValue; the `id` field is auto-assigned a UUID.
            let seeded = newRecord()
            NavigationStack {
                DesktopSettingsListRecordEditor(
                    title: "New \(entry.label.lowercased())",
                    schema: entry.itemSchema ?? [],
                    record: seeded,
                    onSave: { newRecord in
                        appendRecord(newRecord)
                        showAddSheet = false
                    },
                    onCancel: { showAddSheet = false }
                )
            }
        }
    }

    // MARK: - Record extraction + rendering

    /// One record in the list. Wraps the wire dictionary in a Swift
    /// struct so SwiftUI ForEach can identify it stably. The `id`
    /// field on the wire becomes our SwiftUI `Identifiable.id`; if
    /// the wire omits an `id` we synthesize one from the index
    /// (which is stable per render but not across reorders — fine
    /// for the immediate rendering pass).
    struct ListRecord: Identifiable, Hashable {
        let id: String
        let fields: [String: AnyCodable]

        func hash(into hasher: inout Hasher) { hasher.combine(id) }
        static func == (lhs: ListRecord, rhs: ListRecord) -> Bool { lhs.id == rhs.id }

        /// Wire-format dictionary representation. Used when writing
        /// the full list back via `set_desktop_setting`.
        var wireDict: [String: AnyCodable] { fields }
    }

    /// Pull the current records from `viewModel.desktopSettings`. Falls
    /// back to an empty array when the snapshot hasn't arrived yet.
    private func currentRecords() -> [ListRecord] {
        guard let state = viewModel.desktopSettings,
              let raw = state.currentValue(for: entry.key)?.value as? [AnyCodable]
        else { return [] }
        return raw.enumerated().compactMap { (index, codable) in
            guard let dict = codable.value as? [String: AnyCodable] else { return nil }
            let id = (dict["id"]?.value as? String) ?? "row-\(index)"
            return ListRecord(id: id, fields: dict)
        }
    }

    /// Render one record's summary row. Primary label is the first
    /// non-`id` string field in the schema (e.g. `name`); fallback to
    /// the record's `id`.
    @ViewBuilder
    private func recordRow(_ record: ListRecord) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(rowLabel(for: record)).font(.body)
                if let subtitle = rowSubtitle(for: record) {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    /// Primary label for a record. Uses the first non-hidden
    /// string-typed schema field's value, falling back to the
    /// record's id.
    private func rowLabel(for record: ListRecord) -> String {
        guard let schema = entry.itemSchema else { return record.id }
        for field in schema where !Self.hiddenFieldKeys.contains(field.key) && field.type == .string {
            if let v = record.fields[field.key]?.value as? String, !v.isEmpty {
                return v
            }
        }
        return record.id
    }

    /// Optional secondary label. Uses the second non-hidden string-
    /// typed field's value, when present. Gives the row some context
    /// without forcing the user to drill in (e.g. shows the
    /// QuickTool's command beneath its name).
    private func rowSubtitle(for record: ListRecord) -> String? {
        guard let schema = entry.itemSchema else { return nil }
        var seenFirst = false
        for field in schema where !Self.hiddenFieldKeys.contains(field.key) && field.type == .string {
            if !seenFirst { seenFirst = true; continue }
            if let v = record.fields[field.key]?.value as? String, !v.isEmpty {
                return v
            }
        }
        return nil
    }

    // MARK: - Mutations (all go through the wire)

    /// Build a new record seeded with defaults from the itemSchema.
    /// `id` is auto-assigned a UUID — the user never edits it. Other
    /// hidden fields (`order`, `collapsed`) get their schema
    /// defaultValue so the desktop receives a fully-populated record
    /// even though iOS won't render rows for those fields.
    private func newRecord() -> ListRecord {
        let newId = UUID().uuidString.lowercased()
        var fields: [String: AnyCodable] = ["id": AnyCodable(newId)]
        for field in entry.itemSchema ?? [] where field.key != "id" {
            fields[field.key] = field.defaultValue
        }
        return ListRecord(id: newId, fields: fields)
    }

    private func addNewRecord() {
        showAddSheet = true
        Haptic.light()
    }

    /// Append the staged record and send the full list over the wire.
    private func appendRecord(_ record: ListRecord) {
        var next = currentRecords()
        next.append(record)
        sendList(next)
        Haptic.success()
    }

    /// Replace an existing record (matched by id) with an updated
    /// field map and send the full list over the wire.
    private func updateRecord(id: String, with updated: ListRecord) {
        var next = currentRecords()
        guard let idx = next.firstIndex(where: { $0.id == id }) else { return }
        next[idx] = updated
        sendList(next)
        Haptic.light()
    }

    /// Remove records at the given offsets and send the truncated
    /// list over the wire.
    private func deleteRecords(at offsets: IndexSet) {
        var next = currentRecords()
        next.remove(atOffsets: offsets)
        sendList(next)
        Haptic.light()
    }

    /// Reorder records and send the new ordering over the wire.
    private func moveRecords(from source: IndexSet, to destination: Int) {
        var next = currentRecords()
        next.move(fromOffsets: source, toOffset: destination)
        sendList(next)
        Haptic.light()
    }

    /// Ship the full updated list back via `set_desktop_setting`. The
    /// wire value is an array of `[String: AnyCodable]` dictionaries,
    /// which AnyCodable encodes as a JSON array of JSON objects.
    ///
    /// Side effects on every send:
    ///   1. **Auto-assign `order`** — if any record has an `order`
    ///      field on the wire, we overwrite it with the record's
    ///      array index so the desktop's order field stays in sync
    ///      with the iOS-visible ordering. The iOS list editor's
    ///      drag-to-reorder is the source of truth for `order`.
    ///   2. **Preserve unknown fields** — the wire record dict is
    ///      passed through verbatim, so any field that the desktop
    ///      persists but the iOS itemSchema doesn't render (e.g.
    ///      `collapsed`, future fields) round-trips unchanged. New
    ///      records seed every itemSchema-declared field from
    ///      `defaultValue` and a fresh UUID for `id`; fields the
    ///      desktop expects but the schema doesn't declare (legacy
    ///      forward-compat) won't be present on a brand-new record
    ///      but the desktop's own defaults handle that on persist.
    private func sendList(_ records: [ListRecord]) {
        let wire = records.enumerated().map { (idx, record) -> AnyCodable in
            var fields = record.fields
            // Sync the order field to the iOS-visible index. We only
            // touch it when the field is already present on the wire
            // (i.e. the desktop expects ordering on this record
            // shape). Records without an `order` field stay untouched.
            if fields["order"] != nil {
                fields["order"] = AnyCodable(idx)
            }
            return AnyCodable(fields)
        }
        viewModel.setDesktopSetting(key: entry.key, value: AnyCodable(wire))
    }
}
