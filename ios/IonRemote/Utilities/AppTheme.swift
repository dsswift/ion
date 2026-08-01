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
    /// No activity in a conversation. Mirrors the desktop `statusIdle` token.
    var statusIdle: Color { get }
    /// Uncommitted changes in a worktree, drawn as a small `!`.
    ///
    /// The glyph is what lets this borrow the danger hue without claiming a
    /// failure -- `git status` has trained everyone to read a terse mark beside a
    /// path as "this has changes". Green said the opposite (success) and a teal
    /// fill collided with statusRunning and statusComplete; amber is unavailable,
    /// being the base-moved sync signal on the same row.
    var worktreeDirty: Color { get }
    var surfaceElevated: Color { get }
    var codeBg: Color { get }
    var userBubbleTint: Color { get }

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
    var statusIdle: Color { _currentTheme.statusIdle }
    var worktreeDirty: Color { _currentTheme.worktreeDirty }
    var surfaceElevated: Color { _currentTheme.surfaceElevated }
    var codeBg: Color { _currentTheme.codeBg }
    var userBubbleTint: Color { _currentTheme.userBubbleTint }
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
