import SwiftUI

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
}

// MARK: - ThemeRegistry

/// Central list of all available themes. Add new themes here.
enum ThemeRegistry {
    nonisolated(unsafe) static let themes: [any AppTheme] = [
        IonDefaultTheme(),
        JarvisArcReactorTheme(),
    ]

    static func theme(for id: String) -> any AppTheme {
        themes.first { $0.id == id } ?? IonDefaultTheme()
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

    var selectedThemeId: String {
        didSet {
            guard selectedThemeId != oldValue else { return }
            DiagnosticLog.log("[ThemeManager] selectedThemeId changed: \(oldValue) -> \(selectedThemeId)")
            _currentTheme = ThemeRegistry.theme(for: selectedThemeId)
            DiagnosticLog.log("[ThemeManager] resolved theme id: \(_currentTheme.id)")
            UserDefaults.standard.set(selectedThemeId, forKey: "selectedTheme")
        }
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: "selectedTheme") ?? "ion-default"
        self.selectedThemeId = saved
        self._currentTheme = ThemeRegistry.theme(for: saved)
        DiagnosticLog.log("[ThemeManager] init — loaded theme: \(saved)")
        DiagnosticLog.log("[ThemeManager] init — accent color: \(self._currentTheme.accent)")
        DiagnosticLog.log("[ThemeManager] init — _currentTheme type: \(type(of: self._currentTheme))")
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
    var surfaceElevated: Color { _currentTheme.surfaceElevated }
    var codeBg: Color { _currentTheme.codeBg }
    var userBubbleTint: Color { _currentTheme.userBubbleTint }
    var preferredColorScheme: ColorScheme? { _currentTheme.preferredColorScheme }
    var backgroundView: AnyView? { _currentTheme.backgroundView }
    var activityIndicator: ((Bool) -> AnyView)? { _currentTheme.activityIndicator }
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
