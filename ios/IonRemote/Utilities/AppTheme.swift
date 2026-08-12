import SwiftUI
import UIKit

// MARK: - AppTheme Protocol

/// A theme defines the visual identity for the entire app.
/// Conformers supply color tokens, an optional forced color scheme,
/// an optional full-screen background view, and an optional custom
/// activity indicator that replaces the default spinner.
protocol AppTheme {
    var id: String { get }
    var displayName: String { get }

    // Color tokens
    var accent: Color { get }
    var accentSubtle: Color { get }
    var accentGlow: Color { get }
    var background: Color { get }
    var textPrimary: Color { get }
    var textSecondary: Color { get }
    var statusRunning: Color { get }
    var statusDone: Color { get }
    var statusError: Color { get }
    var statusPending: Color { get }
    /// "Awaiting children" — the orchestrator is idle but dispatched
    /// background agents are still executing. Rendered as a yellow/
    /// amber pulsing dot on the parent tab pill, sub-tab pill, and
    /// footer state label. Mirrors the desktop's
    /// `statusWaitingChildren` token in `theme-tokens.ts`. Distinct
    /// from `statusRunning` (terracotta orange = foreground) so foreground vs.
    /// background activity is visually disambiguated. See
    /// `ConversationStatusBar.swift` and `TabRowView.swift` for the
    /// render sites.
    var statusWaitingChildren: Color { get }
    /// Background bash commands the session is holding for. Rendered as a
    /// pink pulsing dot, ranked directly after `statusWaitingChildren` in the
    /// tab-dot cascade. Mirrors the desktop's `statusBash` token — a shell
    /// process running detached from any turn, distinct from a dispatched
    /// agent. See `TabStatusRollup.swift` and `EngineInstanceBar.swift`.
    var statusBash: Color { get }
    /// Mixed tool-group outcome: some tools failed, but not all. Amber
    /// triangle. Distinct from `statusError` (all failed) so partial
    /// failure is visually differentiated from total failure.
    var statusWarning: Color { get }
    /// A tool that has been running long enough to watch but is not yet stalled.
    ///
    /// A third warm role beside `statusRunning` and `statusWarning`, and it
    /// needs to be: `statusRunning` is the terracotta foreground-run hue and
    /// `statusWarning` is the still permission triangle, so neither means
    /// "running long enough to watch". The values sit in the gold band, off
    /// whichever side each theme's `statusWarning` occupies.
    ///
    /// Never paint text on this at full alpha. See `ActiveToolRow.swift`: any
    /// hue saturated enough to read as a warning fill is too light to back
    /// white text, so the render site pairs a low-alpha tint with
    /// `textPrimary` rather than a foreground on a saturated fill.
    var statusActiveWarning: Color { get }
    /// The unfilled portion of a gauge: the empty signal bar, the unconsumed
    /// arc of a usage ring.
    ///
    /// Its own role rather than a reused neutral, for two reasons the render
    /// sites make concrete. `borderSubtle` is a 6%-alpha hairline that
    /// composites to 1.14:1 and simply vanishes as a 4pt fill. `statusIdle`
    /// means "no work in flight", not "capacity not reached", and
    /// `ContextUsageRing` draws its track concentric with a status-colored arc,
    /// so a track in a status hue would read as a second status.
    ///
    /// Opaque in every theme. The literals this replaced used alpha over
    /// `Color.gray` / `Color.secondary`, which is why they were unpredictable:
    /// a system dynamic color composites against the ambient scheme rather than
    /// the active theme.
    ///
    /// Threshold is 3:1 (WCAG 1.4.11): the empty half of a meter carries state,
    /// and this is not the decorative-hairline case, because the track IS the
    /// boundary. `ion-light` is a deliberate exception at 2.90:1 -- see that
    /// theme's note, which records why the 3:1-clearing alternative was refused.
    var gaugeTrack: Color { get }
    /// The agent-bar tint for a `staff` agent, alongside `statusRunning`
    /// (chief), `statusPending` (specialist) and `statusDone` (consultant).
    ///
    /// Violet is the only hue region those three leave open. It takes the same
    /// value as `statusQuestion` in every theme, which is safe because the two
    /// never render on one surface: the agent bar's axes are the type-tinted
    /// pill and the run-state dot, while question is a run state resolved on tab
    /// and rollup surfaces. They stay separate members so a theme can move one
    /// without disturbing the other -- exactly the freedom `jarvis-hud` already
    /// exercises for `statusPending` versus `statusIdle`.
    var statusStaff: Color { get }
    /// Settings category-tile fills. Five values that must be read as a set:
    /// each tile backs a white 14pt semibold glyph, so the binding constraint is
    /// contrast against white, and the set's value is that five categories stay
    /// mutually distinguishable.
    ///
    /// 14pt semibold is large bold text, so 3:1 (WCAG 1.4.3) is the governing
    /// threshold. Four values across `ion-dark` and `ion-classic` land between
    /// 3:1 and 4.5:1: they comply, and darkening them to reach the stricter
    /// 4.5:1 design target would compress the set's internal separation, which
    /// is the property that actually keeps five tiles readable as five
    /// categories.
    var categoryTileConnection: Color { get }
    /// See `categoryTileConnection` -- one member of the category-tile set.
    var categoryTileAppearance: Color { get }
    /// See `categoryTileConnection` -- one member of the category-tile set.
    var categoryTileModels: Color { get }
    /// See `categoryTileConnection` -- one member of the category-tile set.
    var categoryTileVoice: Color { get }
    /// See `categoryTileConnection` -- one member of the category-tile set. Also
    /// the palette's neutral, which is what the intercept-permission toggle
    /// takes: that row is not one of the four navigational categories, and it
    /// previously reused the Models orange, giving two unrelated rows in one
    /// list the same tile color.
    var categoryTileDiagnostics: Color { get }
    /// No activity in a conversation. Mirrors the desktop `statusIdle` token.
    var statusIdle: Color { get }
    /// A conversation waiting on an answer to a question it asked. Rendered as
    /// a violet dot, never as a text foreground.
    ///
    /// Violet is the one hue region the status vocabulary leaves open, and the
    /// separation from its two nearest neighbors is the reason: a question dot
    /// in the blue-cyan band would collide with `statusPending` (and, in
    /// `jarvis-hud`, with the cyan `statusRunning` -- see the note on
    /// `statusWaitingChildren` in `JarvisArcReactorTheme.swift`, which refused a
    /// third cyan for exactly this reason).
    ///
    /// Not fixture-pinned. The desktop declares `statusQuestion` too, but
    /// `ion-light` and `ion-classic` deliberately carry different values there
    /// (`palette-light.ts` pins `#7C3AED`, pinned again by
    /// `palette-parity.test.ts`), so there is no shared value to pin. It joins
    /// `assets/theme-parity.json` if and when both platforms agree on a value.
    var statusQuestion: Color { get }
    /// Uncommitted changes in a worktree, drawn as a small `!`.
    ///
    /// The glyph is what lets this borrow the danger hue without claiming a
    /// failure -- `git status` has trained everyone to read a terse mark beside a
    /// path as "this has changes". Green said the opposite (success) and a teal
    /// fill collided with statusRunning and statusComplete; amber is unavailable,
    /// being the base-moved sync signal on the same row.
    var worktreeDirty: Color { get }
    var surfaceElevated: Color { get }
    /// One level above `surfaceElevated`: row fills, chips, tool-bubble
    /// headers, and line-number gutters. Mirrors the desktop
    /// `surfaceSecondary` token. This is the token that replaced the
    /// opaque `secondarySystemBackground` / `tertiarySystemBackground`
    /// system colors a theme pack could never reach.
    var surfaceSecondary: Color { get }
    /// Sheet and pane backgrounds that sit *below* the container rather
    /// than above it — git panes, the file-editor body. Mirrors the
    /// desktop `containerBgCollapsed` token; the iOS name describes the
    /// role, since the desktop's collapsed-container state has no iOS
    /// equivalent.
    var surfaceSunken: Color { get }
    /// Hairline strokes and separators on themed surfaces. Mirrors the
    /// desktop `borderSubtle` token.
    var borderSubtle: Color { get }
    /// The pressed/active state of a tappable themed surface: one rung further
    /// along the tone ladder than `surfaceSecondary`, continuing in the same
    /// direction. Dark themes step lighter, light themes step darker.
    ///
    /// Not fixture-pinned. The desktop declares `surfacePressed` as an alpha
    /// overlay (`rgba(255,255,255,0.10)` in `palette-dark.ts`), whereas the iOS
    /// value is an opaque ladder rung -- an overlay and a fill are different
    /// mechanisms, so there is no shared value to pin.
    var surfacePressed: Color { get }
    /// The emphatic border: focus rings, selection outlines, and the modal
    /// separator on themes whose `overlayScrim` cannot dim (see that token).
    /// Clears 3:1 against `surfaceElevated` in every theme, which is what
    /// separates it from the decorative `borderSubtle` hairline.
    ///
    /// Not fixture-pinned: the desktop palette declares no counterpart.
    var borderStrong: Color { get }
    /// The backdrop behind a modal or sheet.
    ///
    /// Read the treatment note before using this as a visual separator. A black
    /// scrim composited over an already-dark `surfaceElevated` does not dim: it
    /// computes 1.18:1 on `ion-dark`, 1.48:1 on `ion-classic`, and 1.12:1 on
    /// `jarvis-hud`. Raising alpha cannot fix it, because the limit is pure
    /// black against a near-black surface. On every dark theme the modal's
    /// separation therefore comes from a 1pt `borderStrong` outline on the sheet
    /// and this token is hit-testing (tap-to-dismiss) only. The two light themes
    /// genuinely dim (2.81:1 and 2.80:1) and need no outline.
    ///
    /// The token ships in all six themes regardless, because the tap-to-dismiss
    /// surface exists in all six.
    ///
    /// Not fixture-pinned: the desktop palette declares no counterpart.
    var overlayScrim: Color { get }
    var usesSheetOutline: Bool { get }
    /// Placeholder and muted label text on themed surfaces, a step below
    /// `textSecondary`. Mirrors the desktop `textTertiary` token.
    var textTertiary: Color { get }
    var codeBg: Color { get }
    var userBubbleTint: Color { get }

    /// Syntax-highlighting tokens for code blocks — the shared
    /// cross-platform code color vocabulary: desktop maps TextMate scopes
    /// onto them (ionShikiTheme.ts), iOS maps highlight.js classes onto them
    /// (IonCodeTheme.swift). Ion Dark/Light/Classic values are pinned
    /// identical to the desktop palettes by the parity fixture.
    /// Protocol-extension defaults below keep future themes compiling; the
    /// built-ins and SyncedTheme all supply real values.
    var codeKeyword: Color { get }
    var codeString: Color { get }
    var codeNumber: Color { get }
    var codeComment: Color { get }
    var codeFunction: Color { get }
    var codeType: Color { get }
    var codeVariable: Color { get }
    var codeOperator: Color { get }

    /// Forces the app into light or dark mode. Nil means follow system.
    var preferredColorScheme: ColorScheme? { get }

    /// Full-screen decorative background. Nil uses the default system background.
    var backgroundView: AnyView? { get }

    /// Custom activity indicator. `Bool` arg is whether animation is active.
    /// Nil falls back to `ProgressView()`.
    var activityIndicator: ((Bool) -> AnyView)? { get }

    /// Brand mark shown in the Settings appearance surface. Only theme
    /// packs carry logos (see `SyncedTheme`); built-ins inherit the nil
    /// default from the protocol extension below. Declared as a
    /// requirement (not extension-only) so existential access dispatches
    /// to the conforming type's implementation.
    var logoImage: UIImage? { get }
}

extension AppTheme {
    var logoImage: UIImage? { nil }

    var usesSheetOutline: Bool {
        // How much the scrim dims its own surface. A near-black scrim over a
        // near-black surface barely changes luminance, so every dark theme
        // clusters at =1.5:1 (ion-dark 1.18, ion-classic 1.48, contrast-dark
        // 1.09, jarvis 1.12) and genuinely needs the sheet outline. Both light
        // themes dim to ~2.8:1 with their 40% scrim and need none. The 2.0
        // threshold sits between the two clusters with margin on each side.
        contrastRatio(composite(overlayScrim, over: surfaceElevated), surfaceElevated) < 2.0
    }

    // Fallbacks so a theme predating the code tokens still compiles and
    // renders readable (accent for the strong roles, textSecondary for the
    // quiet ones). Every shipped theme overrides every one of them.
    var codeKeyword: Color { accent }
    var codeString: Color { accent }
    var codeNumber: Color { accent }
    var codeComment: Color { textSecondary }
    var codeFunction: Color { accent }
    var codeType: Color { accent }
    var codeVariable: Color { textPrimary }
    var codeOperator: Color { textSecondary }
}

// MARK: - ThemeRegistry

/// Central list of the built-in themes. The four cross-platform themes
/// mirror the desktop registry in `theme-tokens.ts`; Ion Dark/Light/Classic
/// are pinned identical to the desktop palettes by the parity fixture
/// (`assets/theme-parity.json`), while `jarvis-hud` is the iOS part of the
/// two-part Jarvis theme. Custom themes synced from a paired desktop are
/// layered on top by `ThemeManager` (see `reloadCustomThemes`).
enum ThemeRegistry {
    nonisolated(unsafe) static let themes: [any AppTheme] = [
        IonDarkTheme(),
        IonLightTheme(),
        IonClassicTheme(),
        JarvisArcReactorTheme(),
        IonContrastDarkTheme(),
        IonContrastLightTheme(),
    ]

    static func theme(for id: String) -> any AppTheme {
        themes.first { $0.id == id } ?? IonDarkTheme()
    }
}

// MARK: - ThemeManager (Observable)

/// Observable wrapper that drives SwiftUI reactivity when the theme changes.
/// Injected into the environment via `.environment(\.appTheme, themeManager)`.
/// Views read `theme.accent`, `theme.statusRunning` etc. and SwiftUI
/// automatically re-renders when the selected theme changes because
/// ThemeManager is @Observable and the delegating properties read from
/// `_currentTheme`, which is a stored @Observable property.
@Observable
final class ThemeManager: AppTheme {
    // MARK: - Stored properties (tracked by @Observable)

    /// The currently active resolved theme. Stored (not computed) so @Observable
    /// can track it directly. Every delegating color property reads from here,
    /// giving SwiftUI a clear dependency to subscribe to.
    private var _currentTheme: any AppTheme

    /// Custom themes synced from paired desktops (built-ins stay in
    /// ThemeRegistry). Replaced wholesale by `reloadCustomThemes` — on app
    /// launch from SyncedThemeStore, and on every `desktop_theme_manifest`
    /// / theme-asset arrival.
    private(set) var customThemes: [SyncedTheme] = []

    /// Enterprise-enforced theme id (locked `themePolicy` from the active
    /// desktop's settings snapshot). Non-nil overrides `selectedThemeId`
    /// for rendering and disables the theme picker; the user's selection
    /// is preserved and resumes when the policy lifts. Persisted so
    /// enforcement survives an offline relaunch.
    private(set) var enforcedThemeId: String? {
        didSet {
            if let enforcedThemeId {
                UserDefaults.standard.set(enforcedThemeId, forKey: "enforcedThemeId")
            } else {
                UserDefaults.standard.removeObject(forKey: "enforcedThemeId")
            }
        }
    }

    /// Apply (or clear, with nil) the enterprise theme enforcement.
    /// Called from the settings-snapshot handler on every projection, so a
    /// policy change on the desktop propagates without an app restart.
    func setEnforcedTheme(_ id: String?) {
        guard id != enforcedThemeId else { return }
        DiagnosticLog.log("enforced theme changed", tag: "theme.manager", fields: [
            "reason": enforcedThemeId ?? "none",
            "status": id ?? "none"
        ])
        enforcedThemeId = id
        _currentTheme = resolveTheme(id: id ?? selectedThemeId)
    }

    /// Built-ins followed by synced custom themes — the picker order.
    var availableThemes: [any AppTheme] {
        ThemeRegistry.themes + customThemes.map { $0 as any AppTheme }
    }

    var selectedThemeId: String {
        didSet {
            guard selectedThemeId != oldValue else { return }
            DiagnosticLog.log("theme selected id changed", tag: "theme.manager", fields: [
                "reason": oldValue,
                "status": selectedThemeId
            ])
            _currentTheme = resolveTheme(id: enforcedThemeId ?? selectedThemeId)
            DiagnosticLog.log("theme resolved id", tag: "theme.manager", fields: [
                "status": _currentTheme.id
            ])
            UserDefaults.standard.set(selectedThemeId, forKey: "selectedTheme")
        }
    }

    /// Resolve an id against built-ins, then synced customs, falling back
    /// to Ion Dark. A selected custom theme whose pack was uninstalled
    /// therefore renders Ion Dark while the saved id is kept — the choice
    /// restores automatically if the pack returns on a later sync.
    func resolveTheme(id: String) -> any AppTheme {
        if let builtin = ThemeRegistry.themes.first(where: { $0.id == id }) { return builtin }
        if let custom = customThemes.first(where: { $0.id == id }) { return custom }
        return IonDarkTheme()
    }

    /// Replace the custom-theme set (wholesale) and re-resolve the current
    /// theme — the selection (or enforced theme) may have just arrived,
    /// updated, or vanished.
    func reloadCustomThemes(_ payloads: [SyncedThemePayload], store: SyncedThemeStore = .shared) {
        customThemes = payloads.map { SyncedTheme(payload: $0, store: store) }
        _currentTheme = resolveTheme(id: enforcedThemeId ?? selectedThemeId)
        DiagnosticLog.log("custom themes reloaded", tag: "theme.manager", fields: [
            "count": String(customThemes.count),
            "status": _currentTheme.id
        ])
    }

    /// Retired theme ids rewritten to their successors on init:
    ///   - `ion-default` (system-adaptive iOS-only theme) was removed when
    ///     the cross-platform theme set landed; users migrate to `ion-dark`.
    ///   - `jarvis-arc-reactor` was unified with the desktop under the
    ///     shared `jarvis-hud` id (one theme, two platform parts).
    private static let migratedThemeIds: [String: String] = [
        "ion-default": "ion-dark",
        "jarvis-arc-reactor": "jarvis-hud",
    ]

    init() {
        var saved = UserDefaults.standard.string(forKey: "selectedTheme") ?? "ion-dark"
        if let migrated = Self.migratedThemeIds[saved] {
            DiagnosticLog.log("theme id migrated", tag: "theme.manager", fields: [
                "reason": saved,
                "status": migrated
            ])
            saved = migrated
            UserDefaults.standard.set(saved, forKey: "selectedTheme")
        }
        self.selectedThemeId = saved
        // Persisted enterprise enforcement (survives offline relaunch;
        // cleared by the next settings snapshot when the policy lifts).
        self.enforcedThemeId = UserDefaults.standard.string(forKey: "enforcedThemeId")
        self._currentTheme = ThemeRegistry.theme(for: saved)
        // Seed synced custom themes from disk so a selected (or enforced)
        // custom theme renders correctly offline, before any desktop
        // connection exists. Also re-resolves against enforcedThemeId.
        reloadCustomThemes(SyncedThemeStore.shared.allThemes())
        DiagnosticLog.log("theme manager init", tag: "theme.manager", fields: [
            "status": saved,
            "reason": String(describing: self._currentTheme.accent),
            "count": String(describing: type(of: self._currentTheme))
        ])
    }

    // MARK: - AppTheme conformance (delegates to _currentTheme)
    //
    // Each property reads from the stored _currentTheme. Because _currentTheme
    // is a stored @Observable property, SwiftUI tracks access to it and
    // invalidates any view body that called these properties when _currentTheme
    // changes.

    var id: String { _currentTheme.id }
    var displayName: String { _currentTheme.displayName }
    var accent: Color { _currentTheme.accent }
    var accentSubtle: Color { _currentTheme.accentSubtle }
    var accentGlow: Color { _currentTheme.accentGlow }
    var background: Color { _currentTheme.background }
    var textPrimary: Color { _currentTheme.textPrimary }
    var textSecondary: Color { _currentTheme.textSecondary }
    var statusRunning: Color { _currentTheme.statusRunning }
    var statusDone: Color { _currentTheme.statusDone }
    var statusError: Color { _currentTheme.statusError }
    var statusPending: Color { _currentTheme.statusPending }
    var statusWaitingChildren: Color { _currentTheme.statusWaitingChildren }
    var statusBash: Color { _currentTheme.statusBash }
    var statusWarning: Color { _currentTheme.statusWarning }
    var statusActiveWarning: Color { _currentTheme.statusActiveWarning }
    var gaugeTrack: Color { _currentTheme.gaugeTrack }
    var statusStaff: Color { _currentTheme.statusStaff }
    var categoryTileConnection: Color { _currentTheme.categoryTileConnection }
    var categoryTileAppearance: Color { _currentTheme.categoryTileAppearance }
    var categoryTileModels: Color { _currentTheme.categoryTileModels }
    var categoryTileVoice: Color { _currentTheme.categoryTileVoice }
    var categoryTileDiagnostics: Color { _currentTheme.categoryTileDiagnostics }
    var statusIdle: Color { _currentTheme.statusIdle }
    var statusQuestion: Color { _currentTheme.statusQuestion }
    var worktreeDirty: Color { _currentTheme.worktreeDirty }
    var surfaceElevated: Color { _currentTheme.surfaceElevated }
    var surfaceSecondary: Color { _currentTheme.surfaceSecondary }
    var surfaceSunken: Color { _currentTheme.surfaceSunken }
    var surfacePressed: Color { _currentTheme.surfacePressed }
    var borderSubtle: Color { _currentTheme.borderSubtle }
    var borderStrong: Color { _currentTheme.borderStrong }
    var overlayScrim: Color { _currentTheme.overlayScrim }
    var usesSheetOutline: Bool { _currentTheme.usesSheetOutline }
    var textTertiary: Color { _currentTheme.textTertiary }
    var codeBg: Color { _currentTheme.codeBg }
    var userBubbleTint: Color { _currentTheme.userBubbleTint }
    var codeKeyword: Color { _currentTheme.codeKeyword }
    var codeString: Color { _currentTheme.codeString }
    var codeNumber: Color { _currentTheme.codeNumber }
    var codeComment: Color { _currentTheme.codeComment }
    var codeFunction: Color { _currentTheme.codeFunction }
    var codeType: Color { _currentTheme.codeType }
    var codeVariable: Color { _currentTheme.codeVariable }
    var codeOperator: Color { _currentTheme.codeOperator }
    var preferredColorScheme: ColorScheme? { _currentTheme.preferredColorScheme }
    var backgroundView: AnyView? { _currentTheme.backgroundView }
    var activityIndicator: ((Bool) -> AnyView)? { _currentTheme.activityIndicator }
    var logoImage: UIImage? { _currentTheme.logoImage }
}

// MARK: - Environment Key

/// The environment key stores the ThemeManager itself (which conforms to
/// AppTheme). Because ThemeManager is @Observable and all delegating
/// properties read from the stored `_currentTheme` property, SwiftUI
/// tracks property access and re-renders views when the theme changes.
private struct AppThemeKey: EnvironmentKey {
    // defaultValue is only used when no ThemeManager has been injected
    // (e.g. in Xcode Previews that don't set up the environment). The
    // real app always injects via .environment(\.appTheme, themeManager)
    // in IonRemoteApp, so this instance is never used at runtime.
    nonisolated(unsafe) static let defaultValue: ThemeManager = ThemeManager()
}

extension EnvironmentValues {
    var appTheme: ThemeManager {
        get { self[AppThemeKey.self] }
        set { self[AppThemeKey.self] = newValue }
    }
}
