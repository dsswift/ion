import SwiftUI

extension PhoneSettingsPage {
    /// The icon tile color of this page's row, from the active theme.
    func tint(in theme: ThemeManager) -> Color {
        switch self {
        case .appearance: return theme.categoryTileAppearance
        case .behavior: return theme.categoryTileConnection
        case .voice: return theme.categoryTileVoice
        case .notifications, .defaults: return theme.categoryTileModels
        case .diagnostics: return theme.categoryTileDiagnostics
        }
    }
}
