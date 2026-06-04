import SwiftUI

/// Settings detail screen for the currently-connected desktop's
/// projectable user preferences.
///
/// Renders Apple-style grouped sections: one per `DesktopSettingGroupDescriptor`,
/// each with a localized header, a typed row per setting, and a
/// footer that carries the per-setting description prose. Unknown
/// group identifiers (forward-compat from a newer desktop) render
/// under a fallback "Other" section so older iOS builds never crash
/// on a schema they don't recognize.
///
/// Per-desktop scoping: this view binds to `viewModel.desktopSettings`,
/// which is always the snapshot from the currently-active pairing.
/// The navigation bar title surfaces the desktop's display name so the
/// user always knows which machine they're editing — matches Apple's
/// own pattern (Settings → Wi-Fi → [network] → detail page titled with
/// the network name).
///
/// Edits round-trip through the wire: tapping a toggle calls
/// `viewModel.setDesktopSetting`, which sends `set_desktop_setting` to
/// the desktop. The desktop validates, persists, and broadcasts a
/// fresh snapshot back. The view re-renders on the snapshot, so a
/// rejected write (unknown key, wrong type) simply causes the toggle
/// to bounce back to its prior state on the next snapshot. No optimistic
/// state is maintained — the desktop is the source of truth.
///
/// Forward-compat
/// ──────────────
/// Unknown `DesktopSettingType` cases (added by a newer desktop) fall
/// through to a read-only string row rendered from
/// `String(describing:)`. Unknown groups fall through to the "Other"
/// section above. This keeps the view crash-safe across desktop
/// schema additions.
struct DesktopSettingsView: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel

    /// Display name for the desktop whose settings we're showing.
    /// Used as the navigation title. Falls back to "Desktop" if no
    /// pairing is active (which shouldn't happen — the parent view
    /// gates the NavigationLink on `desktopSettings != nil`).
    private var desktopName: String {
        viewModel.activeDevice?.displayName ?? "Desktop"
    }

    var body: some View {
        Group {
            if let state = viewModel.desktopSettings {
                List {
                    introSection
                    ForEach(state.groups) { group in
                        renderGroup(group: group, in: state)
                    }
                    let orphans = state.orphanedEntries()
                    if !orphans.isEmpty {
                        // Forward-compat: when a newer desktop ships a
                        // group identifier this build doesn't know
                        // about, render its rows under a generic
                        // "Other" section rather than dropping them.
                        Section {
                            ForEach(orphans) { entry in
                                row(for: entry, state: state)
                            }
                        } header: {
                            Text("Other")
                        } footer: {
                            Text("These settings come from a newer desktop. Update the iOS app to see them grouped properly.")
                        }
                    }
                }
            } else {
                // Loading state: the snapshot has not yet arrived (e.g.
                // mid-reconnect). Apple-style centered progress instead
                // of an empty list.
                ContentUnavailableView {
                    Label("Loading", systemImage: "arrow.clockwise")
                } description: {
                    Text("Waiting for \(desktopName) to send its settings…")
                }
            }
        }
        .navigationTitle(desktopName)
        .navigationBarTitleDisplayMode(.inline)
    }

    /// First section: a one-line context reminder that the settings
    /// live on the desktop. Apple's Settings.app uses this same
    /// pattern (e.g. Wi-Fi → [network] page has a contextual header
    /// row identifying the network before the configuration toggles).
    private var introSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.title3)
                    .foregroundStyle(theme.accent)
                    .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(desktopName)
                        .font(.headline)
                    Text("Settings saved on this desktop only")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        } footer: {
            Text("Other paired desktops keep their own preferences. To edit a different desktop's settings, switch to it from the picker at the top of Settings.")
        }
    }

    /// Render one group's section. The header is the group label; the
    /// footer is empty by default (descriptions appear inline under
    /// each toggle row so the user can read context without scrolling
    /// past the toggle they're about to flip).
    @ViewBuilder
    private func renderGroup(group: DesktopSettingGroupDescriptor, in state: DesktopSettingsState) -> some View {
        let entries = state.entries(in: group.groupId)
        if !entries.isEmpty {
            Section {
                ForEach(entries) { entry in
                    row(for: entry, state: state)
                }
            } header: {
                Text(group.label)
            }
        }
    }

    /// One row. Renders a labeled control sized to the entry's
    /// declared type. Each row carries the description as
    /// secondary text below the toggle title — the Apple pattern
    /// for settings that need disclosure of what they actually do.
    @ViewBuilder
    func row(for entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        switch entry.type {
        case .boolean:
            booleanRow(entry: entry, state: state)
        case .string:
            stringRow(entry: entry, state: state)
        case .number:
            numberRow(entry: entry, state: state)
        case .enumType:
            enumRow(entry: entry, state: state)
        case .list:
            // Disambiguate record-list vs primitive-list. Record-lists
            // push a NavigationLink to a per-record editor; primitive-
            // lists render inline. The dispatch is on `itemType`: when
            // present, the value is `[primitive]`; when absent (legacy
            // record-list shape), the value is `[{record}]`.
            if entry.itemType != nil {
                DesktopSettingsPrimitiveListEditor(entry: entry, state: state)
            } else {
                listRow(entry: entry, state: state)
            }
        }
    }

    /// Apple-style toggle row: title on the left with the description
    /// beneath in `.caption.secondary`, switch on the right.
    @ViewBuilder
    private func booleanRow(entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        let current = (state.currentValue(for: entry.key)?.value as? Bool) ?? false
        Toggle(isOn: Binding(
            get: { current },
            set: { newValue in
                viewModel.setDesktopSetting(key: entry.key, value: AnyCodable(newValue))
                Haptic.light()
            }
        )) {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.label)
                    .font(.body)
                Text(entry.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
        }
    }

    /// String-typed row. Renders a TextField with the description as a
    /// caption. Saves on commit (return key on the soft keyboard).
    @ViewBuilder
    func stringRow(entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        let current = (state.currentValue(for: entry.key)?.value as? String) ?? ""
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.label)
                .font(.body)
            TextField(entry.label, text: Binding(
                get: { current },
                set: { newValue in
                    viewModel.setDesktopSetting(key: entry.key, value: AnyCodable(newValue))
                }
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

    /// Number-typed row. Renders a Stepper bounded by the entry's
    /// `range` when present, falling back to a permissive `0…10000`
    /// step-1 default. The stepper value is rendered with
    /// `Self.formatStepperValue` to handle integer vs. decimal display
    /// (uiZoom shows "1.5", tabRecoveryTimeoutSec shows "120").
    @ViewBuilder
    func numberRow(entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        let current = (state.currentValue(for: entry.key)?.value as? Double) ?? 0
        let bounds = entry.range.map { $0.min...$0.max } ?? 0...10000
        let step = entry.range?.step ?? 1
        VStack(alignment: .leading, spacing: 4) {
            Stepper(value: Binding(
                get: { current },
                set: { newValue in
                    viewModel.setDesktopSetting(key: entry.key, value: AnyCodable(newValue))
                }
            ), in: bounds, step: step) {
                HStack {
                    Text(entry.label).font(.body)
                    Spacer()
                    Text(Self.formatStepperValue(current, step: step))
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

    /// Format the displayed stepper value. Decimal steps (< 1) render
    /// with one decimal place (uiZoom: "1.5"). Integer steps render as
    /// integers (tabRecoveryTimeoutSec: "120"). Avoids the
    /// "1.0000000000001" display artifact of unbounded Double->String.
    static func formatStepperValue(_ value: Double, step: Double) -> String {
        if step < 1 {
            return String(format: "%.1f", value)
        }
        return String(Int(value.rounded()))
    }

    /// Enum-typed row. Renders an Apple-style Picker with the entry's
    /// `choices`. The Picker's selection binding uses
    /// `DesktopSettingChoice.selectionKey` (a string) because SwiftUI
    /// Pickers don't accept optional tags. The "None" choice's
    /// selectionKey is the empty string; we round-trip that back to
    /// JSON `null` (NSNull) when writing over the wire.
    @ViewBuilder
    func enumRow(entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        let choices = entry.choices ?? []
        let currentRaw = state.currentValue(for: entry.key)?.value
        // Compute the current selection key. Null maps to the empty
        // string sentinel (matches the "None" choice's selectionKey).
        let currentKey: String = {
            if currentRaw is NSNull || currentRaw == nil { return "" }
            if let s = currentRaw as? String { return s }
            return String(describing: currentRaw!)
        }()
        VStack(alignment: .leading, spacing: 4) {
            Picker(entry.label, selection: Binding(
                get: { currentKey },
                set: { newKey in
                    // Reverse-lookup the wire value for the selected
                    // choice. Falls back to JSON null when the picker
                    // somehow surfaces a key we don't recognize (the
                    // forward-compat path).
                    let selected = choices.first { $0.selectionKey == newKey }
                    let wireValue = selected?.value ?? AnyCodable(NSNull())
                    viewModel.setDesktopSetting(key: entry.key, value: wireValue)
                    Haptic.light()
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

    /// List-typed row. Renders a NavigationLink to the per-record
    /// editor screen (`DesktopSettingsListEditor`). The editor
    /// supports add, delete, drag-reorder, and push-to-edit per
    /// record; writes send the entire updated array back over the
    /// wire (snapshot semantics — desktop replaces the whole list).
    @ViewBuilder
    func listRow(entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        let count = ((state.currentValue(for: entry.key)?.value as? [AnyCodable]) ?? []).count
        NavigationLink {
            DesktopSettingsListEditor(entry: entry)
                .environment(viewModel)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(entry.label).font(.body)
                    Spacer()
                    Text("\(count)").foregroundStyle(.secondary)
                }
                Text(entry.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
        }
    }
}
