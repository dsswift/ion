import SwiftUI

/// Returns Settings to its root screen, for a pushed screen whose subject is
/// gone (a server removed from this phone). Nil outside Settings.
struct SettingsNavigation {
    let popToRoot: @MainActor () -> Void
}

extension EnvironmentValues {
    @Entry var settingsNavigation: SettingsNavigation?
}
