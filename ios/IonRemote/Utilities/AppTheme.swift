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

// MARK: - Environment Key

private struct AppThemeKey: EnvironmentKey {
    nonisolated(unsafe) static let defaultValue: any AppTheme = IonDefaultTheme()
}

extension EnvironmentValues {
    var appTheme: any AppTheme {
        get { self[AppThemeKey.self] }
        set { self[AppThemeKey.self] = newValue }
    }
}
