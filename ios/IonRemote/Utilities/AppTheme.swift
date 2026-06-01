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
/// ThemeManager is @Observable and the property access is tracked.
@Observable
final class ThemeManager: AppTheme {
    var selectedThemeId: String {
        didSet {
            UserDefaults.standard.set(selectedThemeId, forKey: "selectedTheme")
        }
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: "selectedTheme") ?? "ion-default"
        self.selectedThemeId = saved
    }

    // MARK: - Resolved theme (private)

    private var resolved: any AppTheme {
        ThemeRegistry.theme(for: selectedThemeId)
    }

    // MARK: - AppTheme conformance (delegates to resolved)

    var id: String { resolved.id }
    var displayName: String { resolved.displayName }
    var accent: Color { resolved.accent }
    var accentSubtle: Color { resolved.accentSubtle }
    var statusRunning: Color { resolved.statusRunning }
    var statusDone: Color { resolved.statusDone }
    var statusError: Color { resolved.statusError }
    var statusPending: Color { resolved.statusPending }
    var surfaceElevated: Color { resolved.surfaceElevated }
    var codeBg: Color { resolved.codeBg }
    var userBubbleTint: Color { resolved.userBubbleTint }
    var preferredColorScheme: ColorScheme? { resolved.preferredColorScheme }
    var backgroundView: AnyView? { resolved.backgroundView }
    var activityIndicator: ((Bool) -> AnyView)? { resolved.activityIndicator }
}

// MARK: - Environment Key

/// The environment key stores the ThemeManager itself (which conforms to
/// AppTheme). Because ThemeManager is @Observable, SwiftUI tracks property
/// access and re-renders views when the resolved theme changes.
private struct AppThemeKey: EnvironmentKey {
    nonisolated(unsafe) static let defaultValue: ThemeManager = ThemeManager()
}

extension EnvironmentValues {
    var appTheme: ThemeManager {
        get { self[AppThemeKey.self] }
        set { self[AppThemeKey.self] = newValue }
    }
}
