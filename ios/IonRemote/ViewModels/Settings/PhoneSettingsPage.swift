import Foundation

/// A settings page this phone keeps for itself, under "This iPhone" or "You"
/// at the root of Settings.
enum PhoneSettingsPage: String, CaseIterable, Hashable, Sendable, Identifiable {
    case appearance
    case behavior
    case voice
    case notifications
    case diagnostics
    case defaults

    var id: String { rawValue }

    /// The root heading a page sits under.
    enum Heading: Sendable {
        case thisPhone
        case you
    }

    var heading: Heading { self == .defaults ? .you : .thisPhone }

    var title: String {
        switch self {
        case .appearance: return "Appearance"
        case .behavior: return "Behavior"
        case .voice: return "Voice"
        case .notifications: return "Notifications"
        case .diagnostics: return "Diagnostics & About"
        case .defaults: return "Defaults"
        }
    }

    var symbol: String {
        switch self {
        case .appearance: return "paintbrush"
        case .behavior: return "switch.2"
        case .voice: return "waveform"
        case .notifications: return "bell.badge"
        case .diagnostics: return "stethoscope"
        case .defaults: return "person.crop.circle"
        }
    }

    /// The settings page id the server's schema files this page's projected
    /// settings under, when it shows any. Appearance shows none: the
    /// server's Appearance settings are for its desktop clients, and this
    /// phone keeps its own look.
    var schemaPageId: String? {
        switch self {
        case .behavior: return "behavior"
        case .notifications: return "notifications"
        case .defaults: return "defaults"
        case .appearance, .voice, .diagnostics: return nil
        }
    }

    /// Words a search should find this page by, beyond its title.
    var keywords: [String] {
        switch self {
        case .appearance: return ["theme", "dark", "light", "tab list", "agent panel", "tab groups", "new tab"]
        case .behavior: return ["conversation intercepts", "alerts", "urgent", "git panel"]
        case .voice: return ["speech", "dictation", "microphone", "api key", "voice mode"]
        case .notifications: return ["inbox", "tray", "resource kinds", "alerts"]
        case .diagnostics: return ["about", "version", "log", "transport", "debug"]
        case .defaults: return ["permission mode", "thinking", "effort", "titles", "new conversations"]
        }
    }

    /// The page a projected setting from the connected server's schema belongs
    /// on, when it is one this phone keeps.
    static func owning(schemaPageId: String?) -> PhoneSettingsPage? {
        guard let schemaPageId else { return nil }
        return allCases.first { $0.schemaPageId == schemaPageId }
    }
}
