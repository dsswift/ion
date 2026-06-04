import SwiftUI

/// Merged "Appearance" detail screen.
///
/// Previously split into two top-level categories — **Appearance** (theme
/// only) and **Interface** (new-tab default directory, tab list toggles,
/// agent panel toggle, tab groups). Splitting two related concepts at
/// such small size added taps without adding clarity, so they're now
/// unified under a single Appearance entry. Section headers within this
/// view preserve the original groupings so users who learned the old
/// shape can still find what they expect.
///
/// This view holds **iOS-local** preferences only. The desktop's own
/// Appearance category (theme mode, layout density, tool-result
/// expansion, etc.) is mirrored separately under
/// "Desktops & Connection → Desktop Settings → Appearance" so iOS
/// becomes a true thin client for the desktop's preferences without
/// duplicating them locally.
struct SettingsAppearanceView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    var body: some View {
        List {
            // ─── Theme ──────────────────────────────────────────────
            // The iOS-side theme is a client-only preference — it
            // affects the colors of the iOS app itself, not the
            // desktop. The desktop carries its own theme setting that
            // is projected separately under Desktop Settings.
            Section {
                Picker("Theme", selection: Binding(
                    get: { theme.selectedThemeId },
                    set: { newValue in
                        theme.selectedThemeId = newValue
                        DiagnosticLog.log("[SettingsView] theme picker set to: \(newValue)")
                    }
                )) {
                    ForEach(ThemeRegistry.themes, id: \.id) { t in
                        Text(t.displayName).tag(t.id)
                    }
                }
                .onChange(of: theme.selectedThemeId) { oldVal, newVal in
                    DiagnosticLog.log("[SettingsView] theme picker changed: \(oldVal) -> \(newVal)")
                    DiagnosticLog.log("[SettingsView] theme.accent is now: \(theme.accent)")
                }
            } header: {
                Text("Theme")
            } footer: {
                Text("Arc Reactor forces dark mode. Ion Default follows system settings.")
            }

            // ─── New Tab ────────────────────────────────────────────
            Section("New Tab") {
                Picker("Default Directory", selection: Binding<String?>(
                    get: { viewModel.defaultBaseDirectory },
                    set: { viewModel.defaultBaseDirectory = $0 }
                )) {
                    Text("None (desktop default)").tag(nil as String?)
                    ForEach(viewModel.recentDirectories, id: \.self) { dir in
                        Text((dir as NSString).lastPathComponent).tag(dir as String?)
                    }
                }
            }

            // ─── Tab List ───────────────────────────────────────────
            Section {
                Toggle(isOn: Binding(
                    get: { viewModel.showGitInfoInTabList },
                    set: { viewModel.showGitInfoInTabList = $0 }
                )) {
                    Label("Show Git Info", systemImage: "arrow.triangle.branch")
                }
                Toggle(isOn: Binding(
                    get: { viewModel.showTabColorInTabList },
                    set: { viewModel.showTabColorInTabList = $0 }
                )) {
                    Label("Show Tab Colors", systemImage: "paintpalette")
                }
            } header: {
                Text("Tab List")
            } footer: {
                Text("Git Info shows the current branch and commit counts. Tab Colors tints rows with the color set on desktop (desktop always shows color).")
            }

            // ─── Agent Panel ────────────────────────────────────────
            Section {
                Toggle(isOn: Binding(
                    get: { viewModel.agentPanelFullScreenPopup },
                    set: { viewModel.agentPanelFullScreenPopup = $0 }
                )) {
                    Label("Full-Screen Agent Detail", systemImage: "rectangle.expand.vertical")
                }
            } header: {
                Text("Agent Panel")
            } footer: {
                Text("When enabled, tapping an agent opens a full-screen detail view instead of expanding inline.")
            }

            // ─── Keyboard Utility Bar ──────────────────────────────
            //
            // Per-view toggles for the keyboard utility bar (the strip
            // above the keyboard with paste / select all / tab / new
            // line / undo / redo / dismiss buttons). The bar's underlying
            // implementation lives in InputBar.swift (CLI) and
            // EngineView.swift (engine view); the toggles default to on
            // and a previous iOS settings refactor (9b3d1e5f) lost the
            // UI for these toggles when it deleted SettingsInterfaceView.
            // Restored here under Appearance because the toggles control
            // visible chrome, which is the right semantic group.
            Section {
                Toggle(isOn: Binding(
                    get: { viewModel.showKeyboardUtilityBarInCLI },
                    set: { viewModel.showKeyboardUtilityBarInCLI = $0 }
                )) {
                    Label("Show in Conversation View", systemImage: "keyboard")
                }
                Toggle(isOn: Binding(
                    get: { viewModel.showKeyboardUtilityBarInEngine },
                    set: { viewModel.showKeyboardUtilityBarInEngine = $0 }
                )) {
                    Label("Show in Engine View", systemImage: "keyboard")
                }
            } header: {
                Text("Keyboard Utility Bar")
            } footer: {
                Text("Adds a toolbar above the keyboard with paste, select all, tab, new line, undo, redo, and dismiss-keyboard buttons. Toggle independently per view.")
            }

            // Tab Groups are managed exclusively from the desktop side
            // now (Desktops & Connection → Desktop Settings → Tabs &
            // Panels). The full editor — grouping mode, group list with
            // add/rename/reorder/delete, and the Planning/In-Progress/
            // Done auto-movement targets — lives there as part of the
            // desktop projection. Editing groups here used to send
            // wire commands directly to the desktop, which made the
            // iOS-local Appearance view a confusing mix of iOS-local
            // preferences and desktop projection. The user-facing rule
            // is now: iOS-local Appearance = iOS-only preferences;
            // anything on the desktop is edited under Desktop Settings.
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}
