import SwiftUI

/// The screen for one of this phone's own settings pages.
struct PhoneSettingsDestination: View {
    let page: PhoneSettingsPage

    var body: some View {
        switch page {
        case .appearance: SettingsAppearanceView()
        case .behavior: ClientOwnedSettingsView(page: .behavior) { InterceptToggleSection() }
        case .voice: SettingsVoiceView()
        case .notifications: NotificationKindsView()
        case .diagnostics: SettingsDiagnosticsView()
        case .defaults: ClientOwnedSettingsView(page: .defaults)
        }
    }
}
