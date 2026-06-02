import SwiftUI

/// Settings detail screen for the currently-connected desktop's
/// projectable user preferences.
///
/// Renders Apple-style grouped sections: one per `DesktopSettingGroupDescriptor`,
/// each with a localized header, a `Toggle` row per setting, and a
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
            Text("Other paired desktops keep their own preferences. To edit a different desktop's settings, switch to it from Paired Desktops.")
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
    private func row(for entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        switch entry.type {
        case .boolean:
            booleanRow(entry: entry, state: state)
        case .string:
            // String rows are not used in the current allowlist; the
            // wire shape supports them so future projections can
            // render here without a code change.
            stringRow(entry: entry, state: state)
        case .number:
            // Same as string: not exercised today but ready for
            // forward-compat with future numeric projections.
            numberRow(entry: entry, state: state)
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

    /// Reserved for future string-typed projections. Renders a
    /// TextField with the description as a caption. Saves on commit
    /// (return key on the soft keyboard).
    @ViewBuilder
    private func stringRow(entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
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

    /// Reserved for future number-typed projections. Renders a
    /// Stepper. Range and step are not encoded in the wire schema
    /// today; we use a permissive default (0...10000, step 1) until a
    /// concrete numeric projection lands and motivates richer schema.
    @ViewBuilder
    private func numberRow(entry: DesktopSettingSchemaEntry, state: DesktopSettingsState) -> some View {
        let current = (state.currentValue(for: entry.key)?.value as? Double) ?? 0
        VStack(alignment: .leading, spacing: 4) {
            Stepper(value: Binding(
                get: { current },
                set: { newValue in
                    viewModel.setDesktopSetting(key: entry.key, value: AnyCodable(newValue))
                }
            ), in: 0...10000, step: 1) {
                HStack {
                    Text(entry.label).font(.body)
                    Spacer()
                    Text("\(Int(current))").foregroundStyle(.secondary)
                }
            }
            Text(entry.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }
}
