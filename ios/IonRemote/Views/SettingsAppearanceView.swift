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

    private var selectedThemeId: String {
        if let enforced = theme.enforcedThemeId,
           theme.availableThemes.contains(where: { $0.id == enforced }) { return enforced }
        return theme.selectedThemeId
    }

    var body: some View {
        List {
            // ─── Theme ──────────────────────────────────────────────
            // The iOS-side theme is a client-only preference — it
            // affects the colors of the iOS app itself, not the
            // desktop. The desktop carries its own theme setting that
            // is projected separately under Desktop Settings.
            Section {
                // Theme-pack brand mark (enterprise logo). Only custom
                // packs carry one; built-ins render no image row.
                if let logo = theme.logoImage {
                    HStack {
                        Spacer()
                        Image(uiImage: logo)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 48)
                        Spacer()
                    }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: IonSpace.contentGap) {
                        ForEach(theme.availableThemes, id: \.id) { item in
                            ThemePreviewCard(
                                item: item,
                                selected: selectedThemeId == item.id,
                                enforced: theme.enforcedThemeId != nil
                            ) {
                                guard theme.enforcedThemeId == nil else { return }
                                theme.selectedThemeId = item.id
                                DiagnosticLog.log("theme card selected", tag: "view.settings", fields: ["status": item.id])
                            }
                        }
                    }
                    .padding(.vertical, IonSpace.hairlineGap)
                }

            } header: {
                Text("Theme")
            } footer: {
                if theme.enforcedThemeId != nil {
                    Text("Theme is managed by your organization.")
                } else {
                    Text("Ion Dark, Ion Classic, and Jarvis HUD render dark; Ion Light renders light. Ion Dark, Ion Light, and Ion Classic match the desktop themes of the same name.")
                }
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

            // ─── Keyboard Utility Bar ──────────────────────────────
            //
            // Per-view toggles for the keyboard utility bar (the strip
            // above the keyboard with paste / select all / tab / new
            // line / undo / redo / dismiss buttons). The bar's underlying
            // implementation lives in InputBar.swift (CLI) and
            // ConversationView.swift (the conversation view); the toggles default to on
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


private struct ThemePreviewCard: View {
    let item: AppTheme
    let selected: Bool
    let enforced: Bool
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                ZStack(alignment: .topTrailing) {
                    VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                        RoundedRectangle(cornerRadius: IonRadius.control)
                            .fill(item.surfaceElevated)
                            .frame(height: 44)
                            .overlay(alignment: .leading) {
                                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                                    Capsule().fill(item.textPrimary).frame(width: 42, height: 4)
                                    Capsule().fill(item.textTertiary).frame(width: 28, height: 3)
                                }.padding(IonSpace.hairlineGap)
                            }
                        HStack(spacing: IonSpace.hairlineGap) {
                            Circle().fill(item.statusError).frame(width: 6, height: 6)
                            Circle().fill(item.statusRunning).frame(width: 6, height: 6)
                            Circle().fill(item.statusDone).frame(width: 6, height: 6)
                        }
                    }
                    if let logo = item.logoImage {
                        Image(uiImage: logo).resizable().scaledToFit().frame(width: 24, height: 24)
                    }
                    if enforced { Image(systemName: "lock.fill").font(IonType.metadata).foregroundStyle(item.textPrimary) }
                }
                Text(item.displayName).font(IonType.microLabel).foregroundStyle(item.textPrimary).lineLimit(2)
            }
            .padding(IonSpace.hairlineGap)
            .frame(width: 96, height: 160, alignment: .topLeading)
            .background(item.background)
            .clipShape(RoundedRectangle(cornerRadius: IonRadius.container))
            .overlay(RoundedRectangle(cornerRadius: IonRadius.container).stroke(selected ? item.accent : item.borderSubtle, lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
        .disabled(enforced)
        .accessibilityLabel(item.displayName)
    }
}
